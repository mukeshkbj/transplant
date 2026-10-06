import { describe, expect, it } from "vitest";
import { cellsToGeoJSON, hoodsToGeoJSON } from "./map-data.ts";

describe("map-data", () => {
  it("normalizes positive lift into 0..1 heat weights and drops non-positive cells", () => {
    const fc = cellsToGeoJSON([
      { lat: 1, lng: 2, lift: 0.04 },
      { lat: 3, lng: 4, lift: 0.02 },
      { lat: 5, lng: 6, lift: -0.01 },
    ]);

    expect(fc.features.map((f) => [f.geometry.coordinates, f.properties.w])).toEqual([
      [[2, 1], 1],
      [[4, 3], 0.5],
    ]);
  });

  it("numbers hoods and flags the active one", () => {
    const hood = { id: "h1", name: "Greenpoint", lat: 40.73, lng: -73.95, score: 0.04, cellCount: 13, byType: [{}], perPerson: [0.04] };

    expect(hoodsToGeoJSON([hood], "h1").features[0]!.properties).toEqual({ id: "h1", label: "1 · Greenpoint", active: true });
  });
});
