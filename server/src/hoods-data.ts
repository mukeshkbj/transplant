import { readFileSync } from "node:fs";
import type { City } from "./cities.ts";
import type { Hood } from "./geo/hoods.ts";

const cache = new Map<string, Hood[]>();
const NON_LATIN = /[^\u0000-\u024F\s'’.,()-]/;

export function loadHoods(city: City): Hood[] {
  const cached = cache.get(city.id);
  if (cached) return cached;
  const all = JSON.parse(readFileSync(new URL(`../data/hoods/${city.id}.json`, import.meta.url), "utf8")) as Hood[];
  const hoods = all.filter((h) => city.hoodKinds.includes(h.kind ?? "") && !NON_LATIN.test(h.name));
  cache.set(city.id, hoods);
  return hoods;
}
