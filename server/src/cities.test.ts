import { describe, expect, it } from "vitest";
import { CITIES, cityLocation } from "./cities.ts";

const city = (id: string) => CITIES.find((c) => c.id === id)!;

describe("cityLocation", () => {
  it("uses the locality query by default", () => {
    expect(cityLocation(city("nyc"))).toEqual({ "filter.location.query": "New York City" });
  });

  it("uses a closed lng-first WKT bbox polygon when the locality is too broad", () => {
    expect(cityLocation(city("tokyo"))).toEqual({
      "filter.location": "POLYGON((139.56 35.53, 139.92 35.53, 139.92 35.82, 139.56 35.82, 139.56 35.53))",
    });
  });
});
