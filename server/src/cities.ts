export interface City {
  id: string;
  name: string;
  /** Free-text location sent to Qloo `filter.location.query`. */
  query: string;
  /** [south, west, north, east] used to fetch OSM neighborhood points. */
  bbox: [number, number, number, number];
  /** Extra OSM admin_level boundaries whose centers count as neighborhoods. */
  adminLevels?: string[];
}

export const CITIES: City[] = [
  { id: "lisbon", name: "Lisbon", query: "Lisbon", bbox: [38.69, -9.23, 38.8, -9.09], adminLevels: ["8"] },
  { id: "nyc", name: "New York City", query: "New York City", bbox: [40.49, -74.26, 40.92, -73.7] },
  { id: "london", name: "London", query: "London", bbox: [51.28, -0.51, 51.69, 0.33] },
];
