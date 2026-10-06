import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fixture } from "../test/fakes.ts";
import { createApp } from "./app.ts";
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
  quota: { remaining: 9000 as number | undefined },
  hoodsFor: loadHoods,
  limits: { resolve: createRateLimiter(limit, 60_000), transplant: createRateLimiter(limit, 60_000) },
});

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const transplantBody = { cityId: "nyc", mode: "moving", people: [{ label: "You", names: ["a"], entities: ["a", "b", "c"], tags: [] }] };

describe("createApp", () => {
  it("reports health and cities", async () => {
    const app = createApp(deps());

    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true, qlooMonthRemaining: 9000 });
    expect(await (await app.request("/api/cities")).json()).toEqual(expect.arrayContaining([{ id: "nyc", name: "New York City" }]));
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

  it("rate-limits per client IP", async () => {
    const app = createApp(deps(1));
    const req = () =>
      app.request("/api/resolve", { ...post({ text: "Aesop" }), headers: { "content-type": "application/json", "fly-client-ip": "1.2.3.4" } });

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });
});
