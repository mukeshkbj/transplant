import type { CityInfo, MapCell, RankedHood } from "../types.ts";

export interface MapViewProps {
  city: CityInfo;
  cells: MapCell[];
  hoods: RankedHood[];
  activeHoodId: string;
  onSelectHood: (hoodId: string) => void;
}

export function MapView(_props: MapViewProps) {
  return <div className="map" />;
}
