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
