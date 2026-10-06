import type { LiftCell } from "./heatmap.ts";

export interface Hood {
  id: string;
  name: string;
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

const nearest = (cell: LiftCell, hoods: Hood[], maxKm: number): Hood | undefined => {
  let best: Hood | undefined;
  let bestKm = maxKm;
  for (const hood of hoods) {
    const km = haversineKm(cell, hood);
    if (km <= bestKm) {
      best = hood;
      bestKm = km;
    }
  }
  return best;
};

export function scoreHoods(cells: LiftCell[], hoods: Hood[], maxKm = 1.5): HoodScore[] {
  const groups = new Map<Hood, LiftCell[]>();
  for (const cell of cells) {
    const hood = nearest(cell, hoods, maxKm);
    if (hood) groups.set(hood, [...(groups.get(hood) ?? []), cell]);
  }
  return [...groups]
    .map(([hood, group]) => {
      const weight = group.reduce((sum, c) => sum + c.popularity, 0) || 1;
      const byType: Record<string, number> = {};
      for (const type of new Set(group.flatMap((c) => Object.keys(c.byType)))) {
        const values = group.flatMap((c) => (type in c.byType ? [c.byType[type]!] : []));
        byType[type] = values.reduce((sum, v) => sum + v, 0) / values.length;
      }
      return {
        hood,
        lift: group.reduce((sum, c) => sum + c.lift * c.popularity, 0) / weight,
        cellCount: group.length,
        byType,
      };
    })
    .sort((x, y) => y.lift - x.lift);
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
