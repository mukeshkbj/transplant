import { describe, expect, it } from "vitest";
import type { LiftCell } from "./heatmap.ts";
import { blendHoods, type Hood, haversineKm, scoreHoods } from "./hoods.ts";

const hoods: Hood[] = [
  { id: "arroios", name: "Arroios", lat: 38.73, lng: -9.135 },
  { id: "alfama", name: "Alfama", lat: 38.711, lng: -9.13 },
];

const lc = (lat: number, lng: number, lift: number, popularity = 0.5, byType: Record<string, number> = {}): LiftCell => ({
  geohash: `${lat},${lng}`,
  lat,
  lng,
  lift,
  popularity,
  affinity: 0,
  byType,
});

describe("haversineKm", () => {
  it("measures ~2.1 km between Arroios and Alfama", () => {
    expect(haversineKm(hoods[0]!, hoods[1]!)).toBeCloseTo(2.15, 1);
  });
});

describe("scoreHoods", () => {
  it("assigns cells to the nearest hood and ranks by popularity-weighted lift", () => {
    const cells = [
      lc(38.7305, -9.1352, 0.2, 1.0, { artist: 0.9 }),
      lc(38.7298, -9.1345, 0.0, 1.0, { artist: 0.7 }),
      lc(38.7112, -9.1301, 0.05, 0.5),
    ];

    const scores = scoreHoods(cells, hoods);

    expect(scores.map((s) => s.hood.id)).toEqual(["arroios", "alfama"]);
    expect(scores[0]).toMatchObject({ cellCount: 2 });
    expect(scores[0]!.lift).toBeCloseTo(0.1);
    expect(scores[0]!.byType.artist).toBeCloseTo(0.8);
  });

  it("ignores cells farther than maxKm from every hood", () => {
    expect(scoreHoods([lc(38.8, -9.44, 0.9)], hoods)).toEqual([]);
  });
});

describe("blendHoods", () => {
  it("ranks hoods that suit both people above one person's favourite", () => {
    const a = [
      { hood: hoods[0]!, lift: 0.3, cellCount: 1, byType: {} },
      { hood: hoods[1]!, lift: 0.1, cellCount: 1, byType: {} },
    ];
    const b = [
      { hood: hoods[0]!, lift: -0.1, cellCount: 1, byType: {} },
      { hood: hoods[1]!, lift: 0.08, cellCount: 1, byType: {} },
    ];

    expect(blendHoods(a, b).map((s) => [s.hood.id, s.score])).toEqual([
      ["alfama", 0.08],
      ["arroios", -0.1],
    ]);
  });
});
