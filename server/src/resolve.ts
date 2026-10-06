import { z } from "zod";
import type { Llm } from "./llm/llm.ts";
import { ENTITY_TYPES, searchEntities, searchTags } from "./qloo/api.ts";
import type { QlooClient } from "./qloo/client.ts";

const MAX_ITEMS = 10;

const Extraction = z.strictObject({
  items: z.array(z.strictObject({ query: z.string(), kind: z.enum(["entity", "concept"]), type: z.enum(ENTITY_TYPES) })),
});

const EXTRACT_SYSTEM = `You extract the cultural things a person loves from their message, for a taste-based neighborhood finder.
Return up to ${MAX_ITEMS} items in the order mentioned.
- kind "entity": one specific named thing (artist, band, TV show, film, book, brand, podcast, or a specific venue). Use its canonical name, e.g. "Spirited Away" for "the Ghibli bath-house film".
- kind "concept": a genre, style, cuisine, or category, e.g. "natural wine bars", "jazz", "vintage clothing".
- type: the closest of ${ENTITY_TYPES.join(", ")}; use "place" for venue concepts.
Never invent items that were not mentioned. Skip anything personal (people's names, addresses, health, jobs).`;

export interface ChipOption {
  id: string;
  name: string;
  type: string;
  kind: "entity" | "concept";
  image?: string;
  description?: string;
}

export interface Chip {
  query: string;
  kind: "entity" | "concept";
  status: "resolved" | "ambiguous" | "missing";
  selected?: ChipOption;
  options: ChipOption[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

type Item = z.infer<typeof Extraction>["items"][number];

async function resolveItem(qloo: QlooClient, item: Item): Promise<Chip> {
  const options: ChipOption[] =
    item.kind === "concept"
      ? (await searchTags(qloo, item.query)).map((t) => ({ ...t, kind: "concept" as const }))
      : (await searchEntities(qloo, item.query, item.type)).map(({ popularity: _p, ...c }) => ({ ...c, kind: "entity" as const }));
  const base = { query: item.query, kind: item.kind, options };
  if (options.length === 0) return { ...base, status: "missing" };
  const exact = options.find((o) => norm(o.name) === norm(item.query));
  const selected = exact ?? (item.kind === "concept" || options.length === 1 ? options[0] : undefined);
  return selected ? { ...base, status: "resolved", selected } : { ...base, status: "ambiguous" };
}

export async function resolveTaste(text: string, deps: { qloo: QlooClient; llm: Llm }): Promise<Chip[]> {
  const { items } = await deps.llm.json({ schema: Extraction, name: "taste_items", system: EXTRACT_SYSTEM, prompt: text });
  return Promise.all(items.slice(0, MAX_ITEMS).map((item) => resolveItem(deps.qloo, item)));
}
