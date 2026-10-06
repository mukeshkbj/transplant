import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fakeToolProvider, fixture } from "../test/fakes.ts";
import { createApp } from "./app.ts";
import { CITIES } from "./cities.ts";
import { loadHoods } from "./hoods-data.ts";
import { createRateLimiter } from "./rate-limit.ts";

const deps = (limit = 10) => ({
  qloo: fakeQloo((path, params) => {
    if (path === "/search") return fixture("search-aesop-brand.json");
    if (params["filter.type"] === "urn:heatmap") return fixture("heatmap-indie-nyc.json");
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    return undefined;
  }).client,
  llm: fakeLlm((req) =>
    req.name === "taste_items" ? { items: [{ query: "Aesop", kind: "entity", type: "brand" }] } : Promise.reject(new Error("down")),
  ).llm,
  tools: [fakeToolProvider("p", () => ({ text: "Hello.", calls: [] })).provider],
  quota: { remaining: 9000 as number | undefined },
  quotaFloor: 1500,
  hoodsFor: loadHoods,
  limits: {
    resolve: createRateLimiter(limit, 60_000),
    transplant: createRateLimiter(limit, 60_000),
    places: createRateLimiter(limit, 60_000),
    refine: createRateLimiter(limit, 60_000),
  },
});

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const transplantBody = { cityId: "nyc", mode: "moving", people: [{ label: "You", names: ["a"], entities: ["a", "b", "c"], tags: [] }] };

describe("createApp", () => {
  it("reports health and cities", async () => {
    const app = createApp(deps());

    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true, qlooMonthRemaining: 9000, quotaFloor: 1500 });
    expect(await (await app.request("/api/cities")).json()).toEqual(
      expect.arrayContaining([
        { id: "nyc", name: "New York City", beta: false, bbox: [40.49, -74.26, 40.92, -73.7] },
        expect.objectContaining({ id: "tokyo", beta: true }),
      ]),
    );
  });

  it("resolves taste text into chips and rejects bad bodies", async () => {
    const app = createApp(deps());

    const ok = await app.request("/api/resolve", post({ text: "Aesop" }));
    expect((await ok.json()).chips[0]).toMatchObject({ query: "Aesop", status: "resolved" });
    expect((await app.request("/api/resolve", post({ text: "" }))).status).toBe(400);
  });

  it("streams transplant events as SSE", async () => {
    const res = await createApp(deps()).request("/api/transplant", post(transplantBody));

    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    for (const event of ["hoods", "places", "story", "done"]) expect(text).toContain(`event: ${event}`);
  });

  it("returns curated places for another hood and 404s unknown hoods", async () => {
    const app = createApp(deps());
    const greenpoint = loadHoods(CITIES.find((c) => c.id === "nyc")!).find((h) => h.name === "Greenpoint")!;
    const people = transplantBody.people;

    const ok = await app.request("/api/places", post({ cityId: "nyc", hoodId: greenpoint.id, people }));
    expect((await ok.json()).places.map((p: { name: string }) => p.name)).toContain("Desert Island");
    expect((await app.request("/api/places", post({ cityId: "nyc", hoodId: "osm:nope", people }))).status).toBe(404);
  });

  it("refines with the guide agent", async () => {
    const greenpoint = loadHoods(CITIES.find((c) => c.id === "nyc")!).find((h) => h.name === "Greenpoint")!;
    const body = { cityId: "nyc", people: transplantBody.people, hoods: [{ id: greenpoint.id, name: "Greenpoint" }], activeHoodId: greenpoint.id, message: "quieter" };

    const res = await createApp(deps()).request("/api/refine", post(body));

    expect(await res.json()).toEqual({ reply: "Hello.", actions: [], trace: [] });
    expect((await createApp(deps()).request("/api/refine", post({ ...body, message: "" }))).status).toBe(400);
  });

  it("rate-limits per client IP", async () => {
    const app = createApp(deps(1));
    const req = () =>
      app.request("/api/resolve", { ...post({ text: "Aesop" }), headers: { "content-type": "application/json", "fly-client-ip": "1.2.3.4" } });

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });
});
