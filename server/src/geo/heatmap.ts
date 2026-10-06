export interface HeatCell {
  geohash: string;
  lat: number;
  lng: number;
  affinity: number;
  popularity: number;
  byType: Record<string, number>;
}

export interface LiftCell extends HeatCell {
  lift: number;
}

interface RawHeatCell {
  location: { latitude: number; longitude: number; geohash: string };
  query: Record<string, number>;
}

const TYPE_AFFINITY = /^entity_(.+)_affinity$/;

export function parseHeatmap(body: { results?: { heatmap?: RawHeatCell[] } }): HeatCell[] {
  return (body.results?.heatmap ?? []).map(({ location, query }) => ({
    geohash: location.geohash,
    lat: location.latitude,
    lng: location.longitude,
    affinity: query.affinity ?? 0,
    popularity: query.popularity ?? 0,
    byType: Object.fromEntries(
      Object.entries(query).flatMap(([key, value]) => {
        const match = TYPE_AFFINITY.exec(key);
        return match ? [[match[1]!, value]] : [];
      }),
    ),
  }));
}

export function tasteLift(cells: HeatCell[], popularityFloor = 0.3): LiftCell[] {
  const n = cells.length;
  if (n === 0) return [];
  const meanPop = cells.reduce((sum, c) => sum + c.popularity, 0) / n;
  const meanAff = cells.reduce((sum, c) => sum + c.affinity, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const c of cells) {
    sxy += (c.popularity - meanPop) * (c.affinity - meanAff);
    sxx += (c.popularity - meanPop) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return cells
    .filter((c) => c.popularity >= popularityFloor)
    .map((c) => ({ ...c, lift: c.affinity - (meanAff + slope * (c.popularity - meanPop)) }))
    .sort((a, b) => b.lift - a.lift);
}
