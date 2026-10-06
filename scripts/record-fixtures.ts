import { mkdir, writeFile } from "node:fs/promises";
import { CITIES } from "../server/src/cities.ts";
import { createQlooClient } from "../server/src/qloo/client.ts";

const PROFILES: Record<string, [query: string, type: string][]> = {
  indie: [
    ["Khruangbin", "urn:entity:artist"],
    ["Fleabag", "urn:entity:tv_show"],
    ["Aesop", "urn:entity:brand"],
  ],
  mainstream: [
    ["Metallica", "urn:entity:artist"],
    ["Top Gun: Maverick", "urn:entity:movie"],
    ["Harley-Davidson", "urn:entity:brand"],
  ],
};

const apiKey = process.env.QLOO_API_KEY;
if (!apiKey) throw new Error("QLOO_API_KEY is missing. Create .env from .env.example.");
const qloo = createQlooClient({ apiKey, baseUrl: process.env.QLOO_BASE_URL });

await mkdir("server/test/fixtures", { recursive: true });
let remaining: number | undefined;

for (const [profile, items] of Object.entries(PROFILES)) {
  const ids: string[] = [];
  for (const [query, types] of items) {
    const { data } = await qloo.get<{ results: { entity_id: string; name: string }[] }>("/search", { query, types, take: 1 });
    const hit = data.results[0];
    if (!hit) throw new Error(`No Qloo match for ${query}`);
    console.log(`${profile}: ${query} -> ${hit.name}`);
    ids.push(hit.entity_id);
  }
  for (const city of CITIES) {
    const res = await qloo.get("/v2/insights", {
      "filter.type": "urn:heatmap",
      "signal.interests.entities": ids,
      "filter.location.query": city.query,
      take: 50,
    });
    remaining = res.monthRemaining;
    await writeFile(`server/test/fixtures/heatmap-${profile}-${city.id}.json`, JSON.stringify(res.data));
    console.log(`${profile}/${city.id}: saved`);
  }
}

console.log(`Done. Monthly Qloo quota remaining: ${remaining}`);
