import { describe, expect, it } from "vitest";
import { fakeQloo, fakeToolProvider, fixture } from "../test/fakes.ts";
import { CITIES } from "./cities.ts";
import { loadHoods } from "./hoods-data.ts";
import { refine } from "./refine.ts";

const nyc = CITIES.find((c) => c.id === "nyc")!;
const greenpoint = loadHoods(nyc).find((h) => h.name === "Greenpoint")!;
const williamsburg = loadHoods(nyc).find((h) => h.name === "Williamsburg")!;
const input = {
  cityId: "nyc",
  people: [{ label: "You", names: ["Khruangbin", "Fleabag", "Aesop"], entities: ["a", "b", "c"], tags: [] }],
  hoods: [
    { id: greenpoint.id, name: "Greenpoint" },
    { id: williamsburg.id, name: "Williamsburg" },
  ],
  activeHoodId: greenpoint.id,
  message: "somewhere quieter",
};

const qloo = () =>
  fakeQloo((path) => {
    if (path === "/v2/tags") return { results: { tags: [{ id: "urn:tag:ambience:qloo:quiet", name: "Quiet", type: "urn:tag:ambience:qloo" }] } };
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    return undefined;
  });

describe("refine", () => {
  it("lets the agent find tags, filter places in an allowed hood, and returns actions plus a trace", async () => {
    const q = qloo();
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "find_tags", args: { query: "quiet" } }] },
      {
        text: "",
        calls: [{ id: "2", name: "find_places", args: { hood_id: greenpoint.id, include_tags: ["urn:tag:ambience:qloo:quiet"], exclude_tags: [] } }],
      },
      { text: "Try **Desert Island** and *Tea Bar*.", calls: [] },
    ]);

    const out = await refine(input, { qloo: q.client, providers: [provider], hoodsFor: loadHoods });

    expect(out.reply).toBe("Try Desert Island and Tea Bar.");
    expect(out.trace.map((t) => t.tool)).toEqual(["find_tags", "find_places"]);
    expect(out.actions).toEqual([{ type: "places", hoodId: greenpoint.id, filters: ["Quiet"], places: expect.any(Array) }]);
    expect(q.calls.find((c) => c.path === "/v2/tags")!.params).toMatchObject({ "filter.parents.types": "urn:entity:place" });
    expect(q.calls.find((c) => c.path === "/v2/insights")!.params).toMatchObject({ "filter.tags": ["urn:tag:ambience:qloo:quiet"] });
    const first = requests[0]!.messages[0]!;
    expect(first.role === "user" ? JSON.parse(first.text.split("\n\nUser: ")[0]!) : {}).toMatchObject({ activeHoodId: greenpoint.id });
  });

  it("rejects hoods the user wasn't shown and tag ids that find_tags never returned", async () => {
    const q = qloo();
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "find_places", args: { hood_id: "osm:elsewhere", include_tags: [], exclude_tags: [] } }] },
      { text: "", calls: [{ id: "2", name: "find_places", args: { hood_id: greenpoint.id, include_tags: ["urn:tag:made:up"], exclude_tags: [] } }] },
      { text: "Okay.", calls: [] },
    ]);

    const out = await refine(input, { qloo: q.client, providers: [provider], hoodsFor: loadHoods });

    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", result: { error: expect.stringMatching(/not one of the user's neighborhoods/) } });
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", result: { error: expect.stringMatching(/call find_tags first/) } });
    expect(out.actions).toEqual([]);
    expect(q.calls).toHaveLength(0);
  });

  it("never lets the agent name places when Qloo returned none", async () => {
    const q = fakeQloo((path) => {
      if (path === "/v2/tags") return { results: { tags: [{ id: "urn:tag:good_for:qloo:nightlife", name: "Nightlife", type: "urn:tag:good_for:qloo" }] } };
      if (path === "/v2/insights") return { results: { entities: [] } };
      return undefined;
    });
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "find_tags", args: { query: "nightlife" } }] },
      { text: "", calls: [{ id: "2", name: "find_places", args: { hood_id: greenpoint.id, include_tags: ["urn:tag:good_for:qloo:nightlife"] } }] },
      { text: "Try Night of Joy and Brooklyn Bowl!", calls: [] },
    ]);

    const out = await refine({ ...input, message: "more nightlife" }, { qloo: q.client, providers: [provider], hoodsFor: loadHoods });

    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", result: { places: [], note: expect.stringMatching(/do not name/i) } });
    expect(out.reply).not.toMatch(/Night of Joy|Brooklyn Bowl/);
    expect(out.reply).toMatch(/couldn't find Nightlife spots in Greenpoint/);
  });

  it("focus_hood switches the active neighborhood", async () => {
    const { provider } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "focus_hood", args: { hood_id: williamsburg.id } }] },
      { text: "Switched to Williamsburg.", calls: [] },
    ]);

    const out = await refine(input, { qloo: qloo().client, providers: [provider], hoodsFor: loadHoods });

    expect(out.actions).toEqual([{ type: "focus", hoodId: williamsburg.id }]);
  });
});
