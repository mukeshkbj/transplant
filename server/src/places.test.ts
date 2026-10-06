import { describe, expect, it } from "vitest";
import { fakeQloo, fixture } from "../test/fakes.ts";
import { curatePlaces, placeLabel } from "./places.ts";
import { placesNear } from "./qloo/api.ts";

const load = async () =>
  placesNear(fakeQloo(() => fixture("places-indie-greenpoint.json")).client, { entities: ["x"], tags: [] }, { lat: 0, lng: 0 });

describe("curatePlaces", () => {
  it("keeps taste-relevant venues and drops infrastructure, offices, and hotels", async () => {
    const names = curatePlaces(await load(), 30).map((p) => p.name);

    expect(names).toEqual(expect.arrayContaining(["Desert Island", "Land to Sea", "Brooklyn Steel", "Beacon's Closet"]));
    for (const banned of ["Newtown Creek Wastewater Treatment Plant", "JAVA STUDIOS", "The Greenpoint Loft", "Away", "Wythe Hotel"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("caps each genre at two and respects the limit, ordered by affinity", async () => {
    const curated = curatePlaces(await load(), 8);
    const counts = new Map<string, number>();
    for (const p of curated) counts.set(p.genre, (counts.get(p.genre) ?? 0) + 1);

    expect(curated.length).toBeLessThanOrEqual(8);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(curated.map((p) => p.affinity)).toEqual([...curated.map((p) => p.affinity)].sort((a, b) => b - a));
  });
});

describe("placeLabel", () => {
  it("turns the primary genre into a readable label", () => {
    expect(placeLabel({ genre: "urn:tag:genre:place:comic_book_store", categories: [] })).toBe("Comic book store");
    expect(placeLabel({ genre: "urn:tag:genre:place:restaurant:cocktail_bar", categories: [] })).toBe("Cocktail bar");
  });

  it("falls back to the first category, then 'Place'", () => {
    expect(placeLabel({ genre: "", categories: ["Cafe"] })).toBe("Cafe");
    expect(placeLabel({ genre: "", categories: [] })).toBe("Place");
  });
});
