import type { MapCell, RankedHood } from "./types.ts";

type Point<P> = { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: P };
type Collection<P> = { type: "FeatureCollection"; features: Point<P>[] };

const point = <P>(lng: number, lat: number, properties: P): Point<P> => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties,
});

export function cellsToGeoJSON(cells: MapCell[]): Collection<{ w: number }> {
  const positive = cells.filter((c) => c.lift > 0);
  const max = Math.max(...positive.map((c) => c.lift), Number.EPSILON);
  return { type: "FeatureCollection", features: positive.map((c) => point(c.lng, c.lat, { w: Number((c.lift / max).toFixed(3)) })) };
}

export function hoodsToGeoJSON(hoods: RankedHood[], activeId?: string): Collection<{ id: string; label: string; active: boolean }> {
  return {
    type: "FeatureCollection",
    features: hoods.map((h, i) => point(h.lng, h.lat, { id: h.id, label: `${i + 1} · ${h.name}`, active: h.id === activeId })),
  };
}
