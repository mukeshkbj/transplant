import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { CITIES } from "../server/src/cities.ts";
import type { Hood } from "../server/src/geo/hoods.ts";

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const overpass = async (query: string): Promise<Response> => {
  for (const url of OVERPASS_URLS) {
    const res = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      headers: { "User-Agent": "transplant-hackathon/0.1 (Qloo Agentic Hackathon)" },
    }).catch(() => undefined);
    if (res?.ok) return res;
    console.warn(`  ${url} -> ${res?.status ?? "network error"}, trying next mirror`);
  }
  throw new Error("All Overpass mirrors failed");
};

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

await mkdir("server/data/hoods", { recursive: true });

for (const city of CITIES) {
  if (existsSync(`server/data/hoods/${city.id}.json`)) {
    console.log(`${city.id}: already fetched, skipping`);
    continue;
  }
  const [south, west, north, east] = city.bbox;
  const bbox = `${south},${west},${north},${east}`;
  const admin = (city.adminLevels ?? []).map((level) => `rel["boundary"="administrative"]["admin_level"="${level}"]["name"](${bbox});`);
  const query = `[out:json][timeout:120];(nwr["place"~"^(suburb|neighbourhood|quarter)$"]["name"](${bbox});${admin.join("")});out center tags;`;
  const res = await overpass(query);
  const { elements } = (await res.json()) as { elements: OsmElement[] };
  const hoods: Hood[] = elements.flatMap((el) => {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    return lat === undefined || lng === undefined ? [] : [{ id: `osm:${el.type}/${el.id}`, name: el.tags.name!, lat, lng }];
  });
  await writeFile(`server/data/hoods/${city.id}.json`, `${JSON.stringify(hoods, null, 1)}\n`);
  console.log(`${city.id}: ${hoods.length} neighborhoods`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
