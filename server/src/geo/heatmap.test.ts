import { describe, expect, it } from "vitest";
import { type HeatCell, parseHeatmap, tasteLift } from "./heatmap.ts";

const cell = (geohash: string, popularity: number, affinity: number): HeatCell => ({
  geohash,
  lat: 0,
  lng: 0,
  popularity,
  affinity,
  byType: {},
});

describe("parseHeatmap", () => {
  it("flattens Qloo heatmap cells and extracts per-type affinity", () => {
    const body = {
      results: {
        heatmap: [
          {
            location: { latitude: 38.72, longitude: -9.13, geohash: "eycs21" },
            query: { affinity: 1, affinity_rank: 0.97, popularity: 0.9, entity_artist_affinity: 0.95, entity_tv_show_affinity_rank: 0.99 },
          },
        ],
      },
    };

    expect(parseHeatmap(body)).toEqual([
      { geohash: "eycs21", lat: 38.72, lng: -9.13, affinity: 1, popularity: 0.9, byType: { artist: 0.95 } },
    ]);
  });

  it("returns [] for an empty or missing heatmap", () => {
    expect(parseHeatmap({})).toEqual([]);
  });
});

describe("tasteLift", () => {
  it("ranks cells by affinity beyond what popularity predicts", () => {
    const cells = [
      cell("dense", 1.0, 1.0),
      cell("mid", 0.6, 0.6),
      cell("tasty", 0.5, 0.75),
      cell("quiet", 0.4, 0.4),
    ];

    const lifted = tasteLift(cells, 0.3);

    expect(lifted[0]!.geohash).toBe("tasty");
    expect(lifted[0]!.lift).toBeGreaterThan(0.1);
    expect(lifted.find((c) => c.geohash === "dense")!.lift).toBeLessThan(lifted[0]!.lift);
  });

  it("drops cells below the popularity floor", () => {
    const cells = [cell("a", 0.9, 0.9), cell("b", 0.5, 0.5), cell("sparse", 0.1, 0.9)];

    expect(tasteLift(cells, 0.3).map((c) => c.geohash)).not.toContain("sparse");
  });
});
