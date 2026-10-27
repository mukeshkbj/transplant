import { describe, expect, it } from "vitest";
import { fakeLlm } from "../test/fakes.ts";
import { separationKm, spreadOut } from "./geo/hoods.ts";
import { leadLoves, type RankedHood, silentLoves, writeStory } from "./story.ts";

const hood = (id: string, byType: Record<string, number>, cellCount = 10): RankedHood => ({
  id,
  name: id,
  lat: 0,
  lng: 0,
  score: 0.05,
  cellCount,
  byType: [byType],
  perPerson: [0.05],
});

// London test case: The Bear (tv_show) scored zero everywhere.
const hoods = [hood("Dudden Hill", { artist: 0.62, tv_show: 0, brand: 0.4 }, 11), hood("Cricklewood", { artist: 0.5, tv_show: 0, brand: 0.7 }, 9), hood("Willesden", { artist: 0.6, tv_show: 0, brand: 0.3 })];
const loves = [
  { name: "Radiohead", type: "artist" },
  { name: "The Bear", type: "tv_show" },
  { name: "Aesop", type: "brand" },
  { name: "Specialty Coffee", type: "tag" },
];
const people = [{ label: "You", names: loves.map((l) => l.name), loves }];

describe("leadLoves", () => {
  it("never credits a love whose type scored zero, and leads each hood with a different love where it can", () => {
    const leads = leadLoves(hoods, loves);
    expect(leads.flat()).not.toContain("The Bear");
    expect(leads.flat()).not.toContain("Specialty Coffee");
    expect(leads[0]![0]).toBe("Radiohead");
    expect(leads[1]![0]).toBe("Aesop");
    expect(silentLoves(hoods, people)).toEqual(["The Bear"]);
  });
});

describe("writeStory guards", () => {
  it("replaces copy that names a silent love, skips the lead love, or repeats another hood's line", async () => {
    const same = "People who love Radiohead and The Bear over-index here.";
    const { llm, requests } = fakeLlm(() => ({
      hoods: hoods.map((h) => ({ hoodId: h.id, headline: h.name, why: same })),
      plan: [],
    }));

    const { story } = await writeStory({ llm, city: "London", mode: "moving", people, hoods, places: [], shared: [] });

    const evidence = JSON.parse(requests[0]!.prompt);
    expect(evidence.people[0].names).not.toContain("The Bear");
    expect(evidence.hoods[1]).toMatchObject({ leadLoves: expect.arrayContaining(["Aesop"]), evidenceCells: 9 });
    const whys = story.hoods.map((h) => h.why);
    expect(new Set(whys).size).toBe(3);
    expect(whys.some((w) => w.includes("The Bear"))).toBe(false);
    expect(whys[1]).toMatch(/Aesop.*9 Qloo map cells/);
  });
});

describe("spreadOut", () => {
  it("drops neighborhoods closer than the city's separation", () => {
    const ranked = [
      { name: "Dudden Hill", lat: 51.554, lng: -0.24 },
      { name: "Willesden Green", lat: 51.547, lng: -0.227 },
      { name: "Camden", lat: 51.539, lng: -0.142 },
    ];
    const km = separationKm([51.28, -0.51, 51.69, 0.33]);
    expect(km).toBe(2.5);
    expect(spreadOut(ranked, km).map((r) => r.name)).toEqual(["Dudden Hill", "Camden"]);
    expect(separationKm([48.815, 2.224, 48.902, 2.47])).toBe(1.5);
  });
});
