import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fixture } from "../test/fakes.ts";
import { loadHoods } from "./hoods-data.ts";
import { runTransplant, type TransplantEvent, type TransplantInput } from "./transplant.ts";

const person = (label: string) => ({ label, names: ["Khruangbin", "Fleabag", "Aesop"], entities: ["a", "b", "c"], tags: [] });

const setup = (heatmaps: string[], llmOk = true) => {
  const queue = heatmaps.map((name) => fixture(name));
  const qloo = fakeQloo((path, params) => {
    if (path === "/v2/insights" && params["filter.type"] === "urn:heatmap") return queue.shift();
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    if (path === "/v2/analysis/compare") return { results: { tags: [{ tag_id: "urn:tag:genre:music:blues", name: "Blues", query: { score: 0.98 } }] } };
    return undefined;
  });
  const { llm, requests } = fakeLlm((req) => {
    if (!llmOk) throw new Error("down");
    const evidence = JSON.parse(req.prompt);
    return {
      hoods: evidence.hoods.map((h: { hoodId: string }) => ({ hoodId: h.hoodId, headline: "h", why: "w" })),
      plan: [
        { when: "Day 1", placeId: evidence.places[0].placeId, note: "n" },
        { when: "Day 2", placeId: "invented", note: "n" },
      ],
    };
  });
  return { deps: { qloo: qloo.client, llm, hoodsFor: loadHoods }, calls: qloo.calls, requests };
};

const run = async (input: TransplantInput, deps: ReturnType<typeof setup>["deps"]) => {
  const events: TransplantEvent[] = [];
  await runTransplant(input, deps, (e) => events.push(e));
  return events;
};

const find = <K extends TransplantEvent["type"]>(events: TransplantEvent[], type: K) =>
  events.find((e): e is Extract<TransplantEvent, { type: K }> => e.type === type)!;

describe("runTransplant", () => {
  it("streams ranked hoods, curated places near the top hood, and a grounded story", async () => {
    const { deps, calls } = setup(["heatmap-indie-nyc.json"]);

    const events = await run({ cityId: "nyc", mode: "moving", people: [person("You")] }, deps);

    expect(events.filter((e) => e.type !== "step").map((e) => e.type)).toEqual(["hoods", "places", "story", "done"]);
    const { hoods, cells, signal } = find(events, "hoods");
    expect(hoods[0]!.name).toBe("Greenpoint");
    expect(hoods).toHaveLength(3);
    expect(cells.length).toBeGreaterThan(50);
    expect(signal.level).toBe("strong");
    expect(String(calls.find((c) => c.params["filter.type"] === "urn:entity:place")!.params["filter.location"])).toMatch(
      /^POINT\(-73\.9\d* 40\.7\d*\)$/,
    );
    expect(find(events, "places").places.map((p) => p.name)).toContain("Desert Island");
    const story = find(events, "story");
    expect(story.source).toBe("llm");
    expect(story.story.plan.map((p) => p.placeId)).not.toContain("invented");
  });

  it("still delivers template copy when the LLM is down", async () => {
    const { deps } = setup(["heatmap-indie-nyc.json"], false);

    const story = find(await run({ cityId: "nyc", mode: "visiting", people: [person("You")] }, deps), "story");

    expect(story.source).toBe("template");
    expect(story.story.plan[0]!.when).toBe("Morning");
  });

  it("blends two people by their weaker score and reports shared tastes", async () => {
    const { deps, requests } = setup(["heatmap-indie-nyc.json", "heatmap-mainstream-nyc.json"]);

    const events = await run({ cityId: "nyc", mode: "moving", people: [person("You"), person("Sam")] }, deps);

    const { hoods } = find(events, "hoods");
    expect(hoods[0]!.perPerson).toHaveLength(2);
    expect(hoods[0]!.score).toBeCloseTo(Math.min(...hoods[0]!.perPerson));
    expect(find(events, "shared").tags[0]!.name).toBe("Blues");
    expect(JSON.parse(requests[0]!.prompt).sharedTastes).toEqual(["Blues"]);
  });

  it("emits a typed error for an unknown city", async () => {
    const { deps } = setup([]);

    const events = await run({ cityId: "atlantis", mode: "moving", people: [person("You")] }, deps);

    expect(events).toEqual([{ type: "error", code: "UNKNOWN_CITY", message: expect.any(String) }]);
  });
});
