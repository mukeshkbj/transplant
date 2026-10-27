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

export interface Love {
  name: string;
  type: string;
}

export interface StoryPerson {
  label: string;
  names: string[];
  loves?: Love[];
}

export interface StoryInput {
  llm: Llm;
  city: string;
  mode: "moving" | "visiting";
  people: StoryPerson[];
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
- hoods: one entry per evidence hood, same hoodId. headline <= 8 words: a concrete hook about the place and the person's taste, not a slogan (never "awaits", "discover", "home sweet home"). why <= 40 words: phrase it as "people who love X over-index here", where X is the hood's leadLoves (exact names, nothing else from people[].names). Each why must read differently: use the hood's standout fact (e.g. "the strongest match in the city"). If you cite evidence, write exactly "across N Qloo heatmap cells" with N = evidenceCells; never call them spots, places or signals, and use no other numbers. Never write category words in place of names; never claim a person will like it; never add facts not in evidence.
- If a hood has no leadLoves, describe its strongestTastes in plain words instead of naming loves.
- plan: 5 entries using only placeIds from evidence. note <= 16 words: name the place and what it is (use its label), and tie it to their taste, e.g. "Coffee at Land to Sea, a cafe-wine bar your natural-wine side will like". mode "moving": a first week ("Day 1".."Day 5") mixing a coffee spot, an evening out, and a weekend browse. mode "visiting": "Morning"/"Afternoon"/"Evening" stops.
- If two people are present, leadLoves holds one love from each person; each why names both (e.g. "people who love Fleabag and people who love Metallica both over-index here"), and mention what both share when sharedTastes exist.`;

const strongest = (byType: Record<string, number>) =>
  Object.entries(byType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([type]) => TYPE_LABELS[type] ?? type);

const topTypes = (byType: Record<string, number>) => strongest(byType).join(" and ");

const RAW_CODES = new RegExp(`\\b(${Object.keys(TYPE_LABELS).join("|")}|byType)\\b`);

/**
 * For each hood, the person's loves that stand out most there: loves whose Qloo type has the highest
 * affinity in this hood relative to the other ranked hoods. Loves whose type scored zero are never chosen,
 * and a love already leading a better-ranked hood leads again only if nothing else scored.
 */
export function leadLoves(hoods: RankedHood[], loves: Love[] | undefined, person = 0): string[][] {
  const typed = (loves ?? []).filter((l) => l.type !== "tag");
  if (typed.length === 0) return hoods.map(() => []);
  const mean = (type: string) => hoods.reduce((sum, h) => sum + (h.byType[person]?.[type] ?? 0), 0) / hoods.length || 1;
  const used = new Set<string>();
  return hoods.map((h) => {
    const byType = h.byType[person] ?? {};
    const ranked = typed
      .filter((l) => (byType[l.type] ?? 0) > 0)
      .map((l, i) => ({ l, i, rel: (byType[l.type] ?? 0) / mean(l.type), raw: byType[l.type] ?? 0 }))
      .sort((a, b) => b.rel - a.rel || b.raw - a.raw || a.i - b.i);
    const fresh = ranked.filter((r) => !used.has(r.l.name));
    const pick = [...fresh, ...ranked.filter((r) => used.has(r.l.name))].slice(0, 2).map((r) => r.l.name);
    if (pick[0]) used.add(pick[0]);
    return pick;
  });
}

/** Loves that scored nowhere among the ranked hoods; copy must never credit them. */
export function silentLoves(hoods: RankedHood[], people: StoryPerson[]): string[] {
  return people.flatMap((p, i) =>
    (p.loves ?? []).filter((l) => l.type !== "tag" && hoods.every((h) => (h.byType[i]?.[l.type] ?? 0) <= 0)).map((l) => l.name),
  );
}

const joinNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function templateWhy(h: RankedHood, leads: string[], note = ""): string {
  const tail = `${note ? ` — ${note}` : ""}, across ${h.cellCount} Qloo heatmap cells.`;
  if (leads.length > 0) return `People who love ${joinNames(leads)} over-index here${tail}`;
  return `Your ${topTypes(h.byType[0] ?? {}) || "overall"} taste over-indexes here${tail}`;
}

function leadsFor(hoods: RankedHood[], people: StoryPerson[]): string[][] {
  const perPerson = people.map((p, i) => leadLoves(hoods, p.loves, i));
  // One person: up to two loves. Blend: the top love from each person.
  return hoods.map((_, h) => (people.length > 1 ? perPerson.flatMap((leads) => leads[h]?.slice(0, 1) ?? []) : (perPerson[0]?.[h] ?? [])));
}

export function templateStory(hoods: RankedHood[], places: Place[], mode: StoryInput["mode"], people: StoryPerson[] = []): Story {
  const slots = mode === "moving" ? ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5"] : ["Morning", "Afternoon", "Evening", "Morning", "Evening"];
  const leads = leadsFor(hoods, people);
  return {
    hoods: hoods.map((h, i) => ({ hoodId: h.id, headline: h.name, why: templateWhy(h, leads[i] ?? [], standout(hoods, i)) })),
    plan: places.slice(0, 5).map((p, i) => ({ when: slots[i]!, placeId: p.id, note: placeLabel(p) })),
  };
}

const mentions = (text: string, name: string) => text.toLowerCase().includes(name.toLowerCase());

/** One true, hood-specific fact so the three lines differ even when one love drives all of them. */
function standout(hoods: RankedHood[], i: number): string {
  const h = hoods[i]!;
  const top = hoods[0]!;
  if (i === 0) return "the strongest taste match in the city";
  const denser = h.cellCount > top.cellCount ? ", backed by more evidence than the top pick" : "";
  return `${i === 1 ? "the runner-up" : "a third option"}, in a different part of the city${denser}`;
}

/** Numbers in copy must be the hood's real evidence count (or its rank); anything else is an invented figure. */
const inventsNumbers = (text: string, h: RankedHood, rank: number, names: string[]) => {
  const stripped = names.reduce((t, n) => t.split(n).join(" "), text);
  return (stripped.match(/\d+/g) ?? []).some((n) => Number(n) !== h.cellCount && Number(n) !== rank);
};

export async function writeStory({ llm, city, mode, people, hoods, places, shared }: StoryInput): Promise<{ story: Story; source: "llm" | "template" }> {
  const leads = leadsFor(hoods, people);
  const silent = silentLoves(hoods, people);
  const evidence = {
    city,
    mode,
    people: people.map(({ label, names }) => ({ label, names: names.filter((n) => !silent.includes(n)) })),
    hoods: hoods.map((h, i) => ({
      hoodId: h.id,
      name: h.name,
      rank: i + 1,
      score: Number(h.score.toFixed(3)),
      evidenceCells: h.cellCount,
      leadLoves: leads[i] ?? [],
      standout: standout(hoods, i),
      strongestTastes: strongest(h.byType[0] ?? {}),
    })),
    places: places.map((p) => ({ placeId: p.id, name: p.name, label: placeLabel(p), categories: p.categories, neighborhood: p.neighborhood })),
    sharedTastes: shared.map((s) => s.name),
  };
  try {
    const raw = await llm.json({ schema: StorySchema, name: "transplant_story", system: SYSTEM, prompt: JSON.stringify(evidence) });
    const index = new Map(hoods.map((h, i) => [h.id, i]));
    const placeIds = new Set(places.map((p) => p.id));
    const seen = new Set<string>();
    const checked = raw.hoods
      .filter((h) => index.has(h.hoodId))
      .map((h) => {
        const i = index.get(h.hoodId)!;
        const lead = leads[i] ?? [];
        const key = h.why.trim().toLowerCase();
        const bad =
          RAW_CODES.test(h.why) ||
          silent.some((n) => mentions(h.why, n)) ||
          (lead[0] !== undefined && !mentions(h.why, lead[0])) ||
          /\b(spots?|places?|signals?)\b/i.test(h.why.match(/\d+\s+\w+/)?.[0] ?? "") ||
          inventsNumbers(h.why, hoods[i]!, i + 1, people.flatMap((p) => p.names)) ||
          seen.has(key);
        seen.add(key);
        const why = bad ? templateWhy(hoods[i]!, lead, standout(hoods, i)) : h.why.trim();
        return { ...h, why: why.charAt(0).toUpperCase() + why.slice(1) };
      });
    const story = { hoods: checked, plan: raw.plan.filter((p) => placeIds.has(p.placeId)).slice(0, 6) };
    if (story.hoods.length > 0) return { story, source: "llm" };
  } catch {
    // LLM unavailable; template below is built from evidence only.
  }
  return { story: templateStory(hoods, places, mode, people), source: "template" };
}
