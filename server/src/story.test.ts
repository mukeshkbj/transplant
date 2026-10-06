import { describe, expect, it } from "vitest";
import { fakeLlm } from "../test/fakes.ts";
import type { Place } from "./qloo/api.ts";
import { type RankedHood, writeStory } from "./story.ts";

const hoods: RankedHood[] = [
  { id: "h1", name: "Greenpoint", lat: 0, lng: 0, score: 0.04, cellCount: 13, byType: [{ artist: 0.9, tv_show: 0.95 }], perPerson: [0.04] },
];
const places = [
  { id: "p1", name: "Desert Island", categories: ["Comic book store"], neighborhood: "Williamsburg" },
  { id: "p2", name: "Land to Sea", categories: ["Cafe"], neighborhood: "Williamsburg" },
] as Place[];
const base = { city: "New York City", mode: "moving" as const, people: [{ label: "You", names: ["Khruangbin"] }], hoods, places, shared: [] };

describe("writeStory", () => {
  it("passes evidence as JSON and drops ids the evidence doesn't contain", async () => {
    const { llm, requests } = fakeLlm(() => ({
      hoods: [
        { hoodId: "h1", headline: "Your crate-digging corner", why: "Fans of Khruangbin over-index here." },
        { hoodId: "ghost", headline: "x", why: "y" },
      ],
      plan: [
        { when: "Day 1", placeId: "p1", note: "Browse zines" },
        { when: "Day 2", placeId: "invented", note: "nope" },
      ],
    }));

    const { story, source } = await writeStory({ ...base, llm });

    expect(JSON.parse(requests[0]!.prompt)).toMatchObject({ city: "New York City", hoods: [{ hoodId: "h1" }], places: [{ placeId: "p1" }, { placeId: "p2" }] });
    expect(source).toBe("llm");
    expect(story.hoods.map((h) => h.hoodId)).toEqual(["h1"]);
    expect(story.plan.map((p) => p.placeId)).toEqual(["p1"]);
  });

  it("falls back to evidence-only template copy when the LLM fails", async () => {
    const { llm } = fakeLlm(() => {
      throw new Error("down");
    });

    const { story, source } = await writeStory({ ...base, llm });

    expect(source).toBe("template");
    expect(story.hoods[0]).toMatchObject({ hoodId: "h1", headline: "Greenpoint" });
    expect(story.hoods[0]!.why).toMatch(/TV/);
    expect(story.plan.map((p) => [p.when, p.placeId])).toEqual([
      ["Day 1", "p1"],
      ["Day 2", "p2"],
    ]);
  });
});
