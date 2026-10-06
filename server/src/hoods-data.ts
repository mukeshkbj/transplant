import { readFileSync } from "node:fs";
import type { City } from "./cities.ts";
import type { Hood } from "./geo/hoods.ts";

const cache = new Map<string, Hood[]>();

export function loadHoods(city: City): Hood[] {
  const cached = cache.get(city.id);
  if (cached) return cached;
  const all = JSON.parse(readFileSync(new URL(`../data/hoods/${city.id}.json`, import.meta.url), "utf8")) as Hood[];
  const hoods = all.filter((h) => city.hoodKinds.includes(h.kind ?? ""));
  cache.set(city.id, hoods);
  return hoods;
}
