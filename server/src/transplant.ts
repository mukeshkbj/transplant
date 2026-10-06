import { z } from "zod";
import { type City, CITIES, cityLocation } from "./cities.ts";
import { type LiftCell, tasteLift } from "./geo/heatmap.ts";
import { blendHoods, type Hood, type HoodScore, scoreHoods } from "./geo/hoods.ts";
import type { Llm } from "./llm/llm.ts";
import { curatePlaces } from "./places.ts";
import { compareTastes, heatmap, type Place, placesNear, type SharedTag, type Signals } from "./qloo/api.ts";
import type { QlooClient } from "./qloo/client.ts";
import { type RankedHood, type Story, writeStory } from "./story.ts";

export const TransplantInputSchema = z.object({
  cityId: z.string().max(40),
  mode: z.enum(["moving", "visiting"]),
  people: z
    .array(
      z
        .object({
          label: z.string().max(40),
          names: z.array(z.string().max(120)).max(15),
          entities: z.array(z.string().max(80)).max(10),
          tags: z.array(z.string().max(120)).max(5),
        })
        .refine((p) => p.entities.length + p.tags.length >= 3, "Pick at least 3 things you love"),
    )
    .min(1)
    .max(2),
});

export type TransplantInput = z.infer<typeof TransplantInputSchema>;

export interface MapCell {
  lat: number;
  lng: number;
  lift: number;
}

export interface SignalStrength {
  level: "strong" | "moderate" | "weak";
  topScore: number;
  cells: number;
}

export type TransplantEvent =
  | { type: "step"; id: string; label: string; status: "running" | "done" }
  | { type: "hoods"; hoods: RankedHood[]; cells: MapCell[]; signal: SignalStrength }
  | { type: "shared"; tags: SharedTag[] }
  | { type: "places"; hoodId: string; places: Place[] }
  | { type: "story"; story: Story; source: "llm" | "template" }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export interface TransplantDeps {
  qloo: QlooClient;
  llm: Llm;
  hoodsFor: (city: City) => Hood[];
}

const TOP_HOODS = 3;
const MAX_CELLS = 400;

const toRanked = (s: HoodScore): RankedHood => ({
  id: s.hood.id,
  name: s.hood.name,
  lat: s.hood.lat,
  lng: s.hood.lng,
  score: s.lift,
  cellCount: s.cellCount,
  byType: [s.byType],
  perPerson: [s.lift],
});

function rankHoods(scores: HoodScore[][]): RankedHood[] {
  const [a = [], b] = scores;
  if (!b) return a.map(toRanked);
  const aById = new Map(a.map((s) => [s.hood.id, s]));
  const bById = new Map(b.map((s) => [s.hood.id, s]));
  return blendHoods(a, b).map((blend) => {
    const sa = aById.get(blend.hood.id)!;
    const sb = bById.get(blend.hood.id)!;
    return {
      ...toRanked(sa),
      score: blend.score,
      cellCount: Math.min(sa.cellCount, sb.cellCount),
      byType: [sa.byType, sb.byType],
      perPerson: [blend.a, blend.b],
    };
  });
}

function mapCells(cells: LiftCell[][]): MapCell[] {
  const [a = [], b] = cells;
  const lookup = b ? new Map(b.map((c) => [c.geohash, c.lift])) : undefined;
  return a
    .flatMap((c) => {
      if (!lookup) return [{ lat: c.lat, lng: c.lng, lift: c.lift }];
      const other = lookup.get(c.geohash);
      return other === undefined ? [] : [{ lat: c.lat, lng: c.lng, lift: Math.min(c.lift, other) }];
    })
    .sort((x, y) => y.lift - x.lift)
    .slice(0, MAX_CELLS);
}

const strength = (top: RankedHood): SignalStrength => ({
  level: top.score >= 0.03 && top.cellCount >= 8 ? "strong" : top.score >= 0.015 ? "moderate" : "weak",
  topScore: top.score,
  cells: top.cellCount,
});

const union = (people: Signals[]): Signals => ({
  entities: [...new Set(people.flatMap((p) => p.entities))],
  tags: [...new Set(people.flatMap((p) => p.tags))],
});

export async function runTransplant(input: TransplantInput, deps: TransplantDeps, emit: (event: TransplantEvent) => void): Promise<void> {
  const city = CITIES.find((c) => c.id === input.cityId);
  if (!city) return emit({ type: "error", code: "UNKNOWN_CITY", message: `Transplant doesn't cover "${input.cityId}" yet.` });
  const hoods = deps.hoodsFor(city);
  const step = async <T>(id: string, label: string, work: () => Promise<T>): Promise<T> => {
    emit({ type: "step", id, label, status: "running" });
    const result = await work();
    emit({ type: "step", id, label, status: "done" });
    return result;
  };

  const lifted = await step("map", `Mapping where your taste lives in ${city.name}`, async () => {
    const out: LiftCell[][] = [];
    for (const person of input.people) out.push(tasteLift(await heatmap(deps.qloo, person, cityLocation(city))));
    return out;
  });
  const ranked = rankHoods(lifted.map((cells) => scoreHoods(cells, hoods))).slice(0, TOP_HOODS);
  const top = ranked[0];
  if (!top) return emit({ type: "error", code: "NO_SIGNAL", message: `Not enough Qloo taste signal in ${city.name} for these picks. Try adding more.` });
  emit({ type: "hoods", hoods: ranked, cells: mapCells(lifted), signal: strength(top) });

  const [first, second] = input.people;
  let shared: SharedTag[] = [];
  if (first && second) {
    shared = await step("compare", "Finding what you both love", () => compareTastes(deps.qloo, first, second));
    emit({ type: "shared", tags: shared });
  }

  const places = await step("places", `Finding your spots in ${top.name}`, async () =>
    curatePlaces(await placesNear(deps.qloo, union(input.people), top)),
  );
  emit({ type: "places", hoodId: top.id, places });

  const { story, source } = await step("story", "Writing your plan", () =>
    writeStory({
      llm: deps.llm,
      city: city.name,
      mode: input.mode,
      people: input.people.map(({ label, names }) => ({ label, names })),
      hoods: ranked,
      places,
      shared,
    }),
  );
  emit({ type: "story", story, source });
  emit({ type: "done" });
}
