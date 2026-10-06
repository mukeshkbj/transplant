import { mkdir, writeFile } from "node:fs/promises";
import type { Demo } from "../server/src/demos.ts";
import { type EntityType, searchEntities, searchTags } from "../server/src/qloo/api.ts";
import { withCache } from "../server/src/qloo/cache.ts";
import { createQlooClient } from "../server/src/qloo/client.ts";
import type { ChipOption } from "../server/src/resolve.ts";

type Pick = [query: string, type: EntityType | "concept"];
type Spec = Omit<Demo, "people"> & { people: { label: string; picks: Pick[] }[] };

const SPECS: Spec[] = [
  {
    id: "nyc-indie",
    title: "Indie, moving to New York",
    blurb: "Khruangbin, Fleabag, Aesop, natural wine",
    cityId: "nyc",
    mode: "moving",
    people: [
      {
        label: "You",
        picks: [
          ["Khruangbin", "artist"],
          ["Fleabag", "tv_show"],
          ["Aesop", "brand"],
          ["natural wine bars", "concept"],
        ],
      },
    ],
  },
  {
    id: "nyc-blend",
    title: "Two tastes, one NYC apartment",
    blurb: "Khruangbin + Fleabag meets Metallica + Top Gun",
    cityId: "nyc",
    mode: "moving",
    people: [
      {
        label: "You",
        picks: [
          ["Khruangbin", "artist"],
          ["Fleabag", "tv_show"],
          ["Aesop", "brand"],
          ["natural wine bars", "concept"],
        ],
      },
      {
        label: "Them",
        picks: [
          ["Metallica", "artist"],
          ["Top Gun: Maverick", "movie"],
          ["Harley-Davidson", "brand"],
        ],
      },
    ],
  },
  {
    id: "la-visit",
    title: "A long weekend in LA",
    blurb: "Kendrick Lamar, The Bear, Patagonia, tacos",
    cityId: "la",
    mode: "visiting",
    people: [
      {
        label: "You",
        picks: [
          ["Kendrick Lamar", "artist"],
          ["The Bear", "tv_show"],
          ["Patagonia", "brand"],
          ["tacos", "concept"],
        ],
      },
    ],
  },
];

const apiKey = process.env.QLOO_API_KEY;
if (!apiKey) throw new Error("QLOO_API_KEY is missing.");
await mkdir(".cache", { recursive: true });
const qloo = withCache(createQlooClient({ apiKey, baseUrl: process.env.QLOO_BASE_URL }), ".cache/qloo.sqlite");

const resolvePick = async ([query, type]: Pick): Promise<ChipOption> => {
  if (type === "concept") {
    const [tag] = await searchTags(qloo, query);
    if (!tag) throw new Error(`No Qloo tag for ${query}`);
    return { ...tag, kind: "concept" };
  }
  const found = await searchEntities(qloo, query, type);
  const hit = found.find((c) => c.name.toLowerCase() === query.toLowerCase()) ?? found[0];
  if (!hit) throw new Error(`No Qloo match for ${query}`);
  const { popularity: _p, ...option } = hit;
  return { ...option, kind: "entity" };
};

const demos: Demo[] = [];
for (const spec of SPECS) {
  const people: Demo["people"] = [];
  for (const person of spec.people) {
    const picks: ChipOption[] = [];
    for (const pick of person.picks) picks.push(await resolvePick(pick));
    people.push({ label: person.label, picks });
  }
  demos.push({ ...spec, people });
  console.log(spec.id, "→", people.map((p) => `${p.label}: ${p.picks.map((o) => `${o.name} (${o.type})`).join(", ")}`).join(" | "));
}
await writeFile("server/data/demos.json", `${JSON.stringify(demos, null, 2)}\n`);
