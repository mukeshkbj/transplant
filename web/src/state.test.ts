import { describe, expect, it } from "vitest";
import { initialState, readyToRun, reducer, type State, toInput } from "./state.ts";
import type { Chip } from "./types.ts";

const resolved = (name: string, kind: "entity" | "concept" = "entity", id = name): Chip => ({
  query: name,
  kind,
  status: "resolved",
  selected: { id, name, type: kind === "entity" ? "artist" : "urn:tag:x", kind },
  options: [],
});

const withChips = (s: State, person: number, chips: Chip[]) => reducer(s, { type: "resolveDone", person, chips });

describe("reducer", () => {
  it("merges re-read chips without duplicates", () => {
    let s = withChips(initialState(), 0, [resolved("Khruangbin")]);
    s = withChips(s, 0, [resolved("Khruangbin"), resolved("Fleabag")]);

    expect(s.people[0]!.chips.map((c) => c.query)).toEqual(["Khruangbin", "Fleabag"]);
  });

  it("resolves an ambiguous chip when an option is picked", () => {
    const ambiguous: Chip = {
      query: "Lost",
      kind: "entity",
      status: "ambiguous",
      options: [
        { id: "1", name: "Lost (2004)", type: "tv_show", kind: "entity" },
        { id: "2", name: "Lost Girl", type: "tv_show", kind: "entity" },
      ],
    };
    const s = reducer(withChips(initialState(), 0, [ambiguous]), { type: "pick", person: 0, chip: 0, optionId: "1" });

    expect(s.people[0]!.chips[0]).toMatchObject({ status: "resolved", selected: { name: "Lost (2004)" } });
  });

  it("builds API input from confirmed picks, splitting entities and concepts", () => {
    const s = withChips(initialState(), 0, [resolved("Khruangbin"), resolved("Natural Wine", "concept", "urn:tag:nw"), resolved("Aesop")]);

    expect(toInput(s)).toEqual({
      cityId: "nyc",
      mode: "moving",
      people: [{ label: "You", names: ["Khruangbin", "Natural Wine", "Aesop"], entities: ["Khruangbin", "Aesop"], tags: ["urn:tag:nw"] }],
    });
    expect(readyToRun(s)).toBe(true);
    expect(readyToRun(reducer(s, { type: "blend", on: true }))).toBe(false);
  });

  it("loads a demo or shared payload as confirmed stamps", () => {
    const s = reducer(initialState(), {
      type: "loadPicks",
      demoId: "london-blend",
      payload: {
        cityId: "london",
        mode: "moving",
        people: [
          {
            label: "You",
            picks: [
              { id: "a", name: "A", type: "artist", kind: "entity" },
              { id: "b", name: "B", type: "tv_show", kind: "entity" },
              { id: "c", name: "C", type: "urn:tag:x", kind: "concept" },
            ],
          },
          {
            label: "Them",
            picks: [
              { id: "d", name: "D", type: "artist", kind: "entity" },
              { id: "e", name: "E", type: "movie", kind: "entity" },
              { id: "f", name: "F", type: "brand", kind: "entity" },
            ],
          },
        ],
      },
    });

    expect(s).toMatchObject({ cityId: "london", blend: true, demoId: "london-blend" });
    expect(readyToRun(s)).toBe(true);
    expect(toInput(s).people[1]).toMatchObject({ label: "Them", entities: ["d", "e", "f"] });
  });

  it("tracks guide turns and applies refined places with their filters", () => {
    let s = reducer(initialState(), { type: "guideAsk", text: "quieter" });
    expect(s.guide).toEqual({ busy: true, turns: [{ role: "user", text: "quieter" }] });

    s = reducer(s, { type: "guideReply", reply: "Try Tea Bar.", trace: [{ tool: "find_tags", summary: "Qloo tags for quiet: Quiet" }] });
    expect(s.guide.busy).toBe(false);
    expect(s.guide.turns.at(-1)).toEqual({ role: "guide", text: "Try Tea Bar.", trace: [{ tool: "find_tags", summary: "Qloo tags for quiet: Quiet" }] });

    s = reducer(s, { type: "hoodPlaces", hoodId: "h1", places: [], filters: ["Quiet"] });
    expect(s.placeFilters).toEqual({ h1: ["Quiet"] });
  });

  it("moves to results on hoods, upserts steps, and returns to intake on early errors", () => {
    let s = reducer(initialState(), { type: "runStart" });
    s = reducer(s, { type: "event", event: { type: "step", id: "map", label: "Mapping", status: "running" } });
    s = reducer(s, { type: "event", event: { type: "step", id: "map", label: "Mapping", status: "done" } });
    expect(s.steps).toEqual([{ id: "map", label: "Mapping", status: "done" }]);

    const failed = reducer(s, { type: "event", event: { type: "error", code: "NO_SIGNAL", message: "Not enough signal" } });
    expect(failed).toMatchObject({ stage: "intake", error: { code: "NO_SIGNAL" } });

    const hood = { id: "h1", name: "Greenpoint", lat: 0, lng: 0, score: 0.04, cellCount: 13, byType: [{}], perPerson: [0.04] };
    s = reducer(s, { type: "event", event: { type: "hoods", hoods: [hood], cells: [], signal: { level: "strong", topScore: 0.04, cells: 13 } } });
    expect(s).toMatchObject({ stage: "results", activeHoodId: "h1" });
  });
});
