export interface City {
  id: string;
  name: string;
  /** Free-text location sent to Qloo `filter.location.query`. */
  query: string;
  /** [south, west, north, east] used to fetch OSM neighborhood points. */
  bbox: [number, number, number, number];
  /** Extra OSM admin_level boundaries whose centers count as neighborhoods. */
  adminLevels?: string[];
  /** Hood kinds meaningful at city scale; excludes tiny estates where OSM maps them as neighbourhoods. */
  hoodKinds: string[];
}

export const CITIES: City[] = [
  {
    id: "lisbon",
    name: "Lisbon",
    query: "Lisbon",
    bbox: [38.69, -9.23, 38.8, -9.09],
    adminLevels: ["8"],
    hoodKinds: ["suburb", "quarter", "admin8"],
  },
  {
    id: "nyc",
    name: "New York City",
    query: "New York City",
    bbox: [40.49, -74.26, 40.92, -73.7],
    hoodKinds: ["suburb", "quarter", "neighbourhood"],
  },
  { id: "london", name: "London", query: "London", bbox: [51.28, -0.51, 51.69, 0.33], hoodKinds: ["suburb", "quarter"] },
  { id: "la", name: "Los Angeles", query: "Los Angeles", bbox: [33.7, -118.67, 34.34, -118.15], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "paris", name: "Paris", query: "Paris", bbox: [48.815, 2.224, 48.902, 2.47], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "berlin", name: "Berlin", query: "Berlin", bbox: [52.338, 13.088, 52.675, 13.761], hoodKinds: ["suburb", "quarter"] },
  { id: "tokyo", name: "Tokyo", query: "Tokyo", bbox: [35.53, 139.56, 35.82, 139.92], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "seoul", name: "Seoul", query: "Seoul", bbox: [37.42, 126.76, 37.7, 127.18], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "cdmx", name: "Mexico City", query: "Mexico City", bbox: [19.2, -99.33, 19.59, -98.94], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "austin", name: "Austin", query: "Austin", bbox: [30.1, -97.94, 30.52, -97.56], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "toronto", name: "Toronto", query: "Toronto", bbox: [43.58, -79.64, 43.86, -79.11], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "barcelona", name: "Barcelona", query: "Barcelona", bbox: [41.32, 2.05, 41.47, 2.23], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
];
