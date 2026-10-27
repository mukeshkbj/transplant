import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fakeToolProvider, fixture } from "../test/fakes.ts";
import { createApp } from "./app.ts";
import { loadHoods } from "./hoods-data.ts";
import { createRateLimiter } from "./rate-limit.ts";

const ITEMS = [
  { query: "Khruangbin", kind: "entity", type: "artist" },
  { query: "Fleabag", kind: "entity", type: "tv_show" },
  { query: "Aesop", kind: "entity", type: "brand" },
];

const deps = (limit = 10) => ({
  qloo: fakeQloo((path, params) => {
    if (path === "/search") return fixture("search-aesop-brand.json");
    if (params["filter.type"] === "urn:heatmap") return fixture("heatmap-indie-nyc.json");
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    return undefined;
  }).client,
  llm: fakeLlm((req) => (req.name === "taste_items" ? { items: ITEMS } : Promise.reject(new Error("down")))).llm,
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

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
});

describe("MCP endpoint", () => {
  it("initializes, acknowledges notifications, and lists tools", async () => {
    const app = createApp(deps());

    const init = await (await app.request("/mcp", rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "transplant" }, capabilities: { tools: {} } });
    expect((await app.request("/mcp", rpc("notifications/initialized", undefined, null))).status).toBe(202);
    const list = await (await app.request("/mcp", rpc("tools/list"))).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["list_cities", "find_neighborhoods", "ask_local_guide"]);
  });

  it("finds neighborhoods with Qloo evidence and an interactive link", async () => {
    const app = createApp(deps());

    const res = await (await app.request("http://localhost/mcp", rpc("tools/call", { name: "find_neighborhoods", arguments: { city: "nyc", loves: "Khruangbin, Fleabag, Aesop" } }))).json();

    expect(res.result.isError).toBeUndefined();
    const out = res.result.structuredContent;
    expect(out.neighborhoods.length).toBeGreaterThan(0);
    expect(out.neighborhoods[0]).toMatchObject({ rank: 1, evidenceCells: expect.any(Number) });
    expect(out.interactiveMap).toMatch(/^http:\/\/localhost\/\?t=/);
    expect(res.result.content[0].text).toMatch(/Where this taste lives in New York City/);
  });

  it("reports bad arguments as tool errors, not protocol errors", async () => {
    const res = await (await createApp(deps()).request("/mcp", rpc("tools/call", { name: "find_neighborhoods", arguments: { city: "atlantis", loves: "x" } }))).json();

    expect(res.result).toMatchObject({ isError: true });
    expect(res.result.content[0].text).toMatch(/Invalid arguments/);
  });
});
