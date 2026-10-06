import { describe, expect, it } from "vitest";
import { fakeQloo, fixture } from "../../test/fakes.ts";
import { compareTastes, heatmap, placesNear, searchEntities, searchTags } from "./api.ts";

describe("Qloo domain API", () => {
  it("searchEntities sends a typed query and maps candidates", async () => {
    const { client, calls } = fakeQloo(() => fixture("search-aesop-brand.json"));

    const [aesop] = await searchEntities(client, "Aesop", "brand");

    expect(calls[0]).toEqual({ path: "/search", params: { query: "Aesop", take: 3, types: "urn:entity:brand" } });
    expect(aesop).toMatchObject({ name: "Aesop", type: "brand" });
    expect(aesop!.image).toMatch(/^https:\/\/images\.qloo\.com\//);
  });

  it("searchTags maps tag ids", async () => {
    const { client } = fakeQloo(() => fixture("tags-natural-wine-bars.json"));

    const tags = await searchTags(client, "natural wine bars");

    expect(tags[0]).toEqual({ id: expect.stringMatching(/^urn:tag:/), name: expect.any(String), type: expect.stringMatching(/^urn:tag:/) });
  });

  it("heatmap sends entity and tag signals with the city", async () => {
    const { client, calls } = fakeQloo(() => fixture("heatmap-indie-nyc.json"));

    const cells = await heatmap(client, { entities: ["E1"], tags: ["urn:tag:x"] }, "New York City");

    expect(calls[0]!.params).toEqual({
      "filter.type": "urn:heatmap",
      "signal.interests.entities": ["E1"],
      "signal.interests.tags": ["urn:tag:x"],
      "filter.location.query": "New York City",
      take: 50,
    });
    expect(cells.length).toBeGreaterThan(100);
  });

  it("placesNear filters by a lng-first WKT point and maps place details", async () => {
    const { client, calls } = fakeQloo(() => fixture("places-indie-greenpoint.json"));

    const places = await placesNear(client, { entities: ["E1"], tags: [] }, { lat: 40.73, lng: -73.95 });

    expect(calls[0]!.params).toMatchObject({ "filter.location": "POINT(-73.95 40.73)", "filter.location.radius": 1200, take: 30 });
    expect(places.find((p) => p.name === "Desert Island")).toMatchObject({
      genre: "urn:tag:genre:place:comic_book_store",
      categories: expect.arrayContaining(["Comic book store"]),
      neighborhood: "Williamsburg",
      closed: false,
    });
  });

  it("compareTastes maps shared tags and skips empty groups", async () => {
    const { client, calls } = fakeQloo(() => ({ results: { tags: [{ tag_id: "urn:tag:genre:music:blues", name: "Blues", query: { score: 0.98 } }] } }));

    expect(await compareTastes(client, { entities: ["A"], tags: [] }, { entities: ["B"], tags: [] })).toEqual([
      { id: "urn:tag:genre:music:blues", name: "Blues", score: 0.98 },
    ]);
    expect(await compareTastes(client, { entities: [], tags: ["t"] }, { entities: ["B"], tags: [] })).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
