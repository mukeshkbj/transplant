import { z } from "zod";
import type { Llm } from "./llm/llm.ts";
import { placeLabel } from "./places.ts";
import type { Place, SharedTag } from "./qloo/api.ts";

export interface RankedHood {
  id: string;
  name: string;
  lat: number;
  lng: number;
  score: number;
  cellCount: number;
  byType: Record<string, number>[];
  perPerson: number[];
}

const StorySchema = z.strictObject({
  hoods: z.array(z.strictObject({ hoodId: z.string(), headline: z.string(), why: z.string() })),
  plan: z.array(z.strictObject({ when: z.string(), placeId: z.string(), note: z.string() })),
});

export type Story = z.infer<typeof StorySchema>;

export interface StoryInput {
  llm: Llm;
  city: string;
  mode: "moving" | "visiting";
  people: { label: string; names: string[] }[];
  hoods: RankedHood[];
  places: Place[];
  shared: SharedTag[];
}

const TYPE_LABELS: Record<string, string> = {
  artist: "music",
  tv_show: "TV",
  movie: "film",
  brand: "brand",
  book: "book",
  podcast: "podcast",
  place: "venue",
  tag: "style",
};

const SYSTEM = `You write short, warm, specific copy for Transplant, an app that finds the neighborhood where a person's taste lives.
Use ONLY the evidence JSON in the user message. Rules:
- hoods: one entry per evidence hood, same hoodId. headline <= 8 words. why <= 40 words: say which of their tastes (byType: artist=music, tv_show=TV, movie=film, brand, tag=style) are strongest there, phrased as "people who love X over-index here". Never claim a person will like it; never add facts not in evidence.
- plan: 5 entries using only placeIds from evidence. note <= 16 words: name the place and what it is (use its label), and tie it to their taste, e.g. "Coffee at Land to Sea, a cafe-wine bar your natural-wine side will like". mode "moving": a first week ("Day 1".."Day 5") mixing a coffee spot, an evening out, and a weekend browse. mode "visiting": "Morning"/"Afternoon"/"Evening" stops.
- If two people are present, mention what both share when sharedTastes exist.`;

const topTypes = (byType: Record<string, number>) =>
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([type]) => TYPE_LABELS[type] ?? type)
    .join(" and ");

export function templateStory(hoods: RankedHood[], places: Place[], mode: StoryInput["mode"]): Story {
  const slots = mode === "moving" ? ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5"] : ["Morning", "Afternoon", "Evening", "Morning", "Evening"];
  return {
    hoods: hoods.map((h) => ({
      hoodId: h.id,
      headline: h.name,
      why: `Your ${topTypes(h.byType[0] ?? {}) || "overall"} taste over-indexes here more than anywhere else in the city, across ${h.cellCount} Qloo heatmap cells.`,
    })),
    plan: places.slice(0, 5).map((p, i) => ({ when: slots[i]!, placeId: p.id, note: placeLabel(p) })),
  };
}

export async function writeStory({ llm, city, mode, people, hoods, places, shared }: StoryInput): Promise<{ story: Story; source: "llm" | "template" }> {
  const evidence = {
    city,
    mode,
    people,
    hoods: hoods.map((h) => ({ hoodId: h.id, name: h.name, score: Number(h.score.toFixed(3)), byType: h.byType })),
    places: places.map((p) => ({ placeId: p.id, name: p.name, label: placeLabel(p), categories: p.categories, neighborhood: p.neighborhood })),
    sharedTastes: shared.map((s) => s.name),
  };
  try {
    const raw = await llm.json({ schema: StorySchema, name: "transplant_story", system: SYSTEM, prompt: JSON.stringify(evidence) });
    const hoodIds = new Set(hoods.map((h) => h.id));
    const placeIds = new Set(places.map((p) => p.id));
    const story = { hoods: raw.hoods.filter((h) => hoodIds.has(h.hoodId)), plan: raw.plan.filter((p) => placeIds.has(p.placeId)).slice(0, 6) };
    if (story.hoods.length > 0) return { story, source: "llm" };
  } catch {
    // LLM unavailable; template below is built from evidence only.
  }
  return { story: templateStory(hoods, places, mode), source: "template" };
}
