import { describe, expect, it } from "vitest";
import { CITIES } from "./cities.ts";
import { loadHoods } from "./hoods-data.ts";

describe("loadHoods", () => {
  it("keeps only the city's configured kinds and Latin-script names", () => {
    for (const city of CITIES) {
      const hoods = loadHoods(city);

      expect(hoods.length, city.id).toBeGreaterThan(20);
      expect(hoods.every((h) => city.hoodKinds.includes(h.kind ?? "")), city.id).toBe(true);
      expect(hoods.filter((h) => /[^\u0000-\u024F\s'’.,()-]/.test(h.name)).map((h) => h.name), city.id).toEqual([]);
    }
  });
});
