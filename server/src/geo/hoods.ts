import type { LiftCell } from "./heatmap.ts";

export interface Hood {
  id: string;
  name: string;
  /** OSM place value (suburb, quarter, neighbourhood) or `admin<level>`. */
  kind?: string;
  lat: number;
  lng: number;
}

export interface HoodScore {
  hood: Hood;
  lift: number;
  cellCount: number;
  byType: Record<string, number>;
}

export interface BlendScore {
  hood: Hood;
  score: number;
  a: number;
  b: number;
}

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export interface ScoreOptions {
  /** Cells within this distance of a hood's center count toward it. */
  radiusKm?: number;
  /** Pseudo-weight of zero lift added to every hood; shrinks thin evidence. */
  prior?: number;
  /** Hoods with fewer nearby cells are dropped as noise. */
  minCells?: number;
  /** A hood this close to a better-ranked one is dropped, so the ranking lists distinct areas. */
  minSeparationKm?: number;
}

export function scoreHoods(
  cells: LiftCell[],
  hoods: Hood[],
  { radiusKm = 1.5, prior = 2, minCells = 4, minSeparationKm = 1 }: ScoreOptions = {},
): HoodScore[] {
  const scores = hoods.flatMap((hood) => {
    const group = cells.filter((c) => haversineKm(c, hood) <= radiusKm);
    if (group.length < minCells) return [];
    const weight = group.reduce((sum, c) => sum + c.popularity, 0);
    const byType: Record<string, number> = {};
    for (const type of new Set(group.flatMap((c) => Object.keys(c.byType)))) {
      const values = group.flatMap((c) => (type in c.byType ? [c.byType[type]!] : []));
      byType[type] = values.reduce((sum, v) => sum + v, 0) / values.length;
    }
    return [{ hood, lift: group.reduce((sum, c) => sum + c.lift * c.popularity, 0) / (weight + prior), cellCount: group.length, byType }];
  });
  const kept: HoodScore[] = [];
  for (const s of scores.sort((x, y) => y.lift - x.lift)) {
    if (kept.some((k) => k.hood.name === s.hood.name || haversineKm(k.hood, s.hood) < minSeparationKm)) continue;
    kept.push(s);
  }
  return kept;
}

export function blendHoods(a: HoodScore[], b: HoodScore[]): BlendScore[] {
  const byId = new Map(b.map((s) => [s.hood.id, s]));
  return a
    .flatMap((sa) => {
      const sb = byId.get(sa.hood.id);
      return sb ? [{ hood: sa.hood, a: sa.lift, b: sb.lift, score: Math.min(sa.lift, sb.lift) }] : [];
    })
    .sort((x, y) => y.score - x.score);
}
