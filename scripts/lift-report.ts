import { readFileSync } from "node:fs";
import { CITIES } from "../server/src/cities.ts";
import { parseHeatmap, tasteLift } from "../server/src/geo/heatmap.ts";
import { type HoodScore, scoreHoods } from "../server/src/geo/hoods.ts";
import { loadHoods } from "../server/src/hoods-data.ts";

const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fmt = (scores: HoodScore[]) =>
  scores.map((s) => `${s.hood.name} (${s.lift.toFixed(3)}, ${s.cellCount}c)`).join(" | ");

let passes = 0;
for (const city of CITIES) {
  const hoods = loadHoods(city);
  const top = (profile: string) =>
    scoreHoods(tasteLift(parseHeatmap(load(`server/test/fixtures/heatmap-${profile}-${city.id}.json`))), hoods).slice(0, 3);
  const indie = top("indie");
  const mainstream = top("mainstream");
  const overlap = indie.filter((x) => mainstream.some((y) => y.hood.id === x.hood.id)).length;
  const pass = indie.length === 3 && mainstream.length === 3 && overlap <= 1;
  if (pass) passes++;
  console.log(
    `\n${city.name}${city.beta ? " [beta]" : ""}\n  indie:      ${fmt(indie)}\n  mainstream: ${fmt(mainstream)}\n  overlap ${overlap}/3 -> ${pass ? "PASS" : "FAIL"}`,
  );
}
console.log(`\n${passes}/${CITIES.length} cities pass`);
