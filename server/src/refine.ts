import { z } from "zod";
import { type AgentTool, runAgent, type TraceStep } from "./agent.ts";
import { type City, CITIES } from "./cities.ts";
import type { Hood } from "./geo/hoods.ts";
import type { ToolProvider } from "./llm/tools.ts";
import { curatePlaces, placeLabel } from "./places.ts";
import { type Place, placesNear, searchTags } from "./qloo/api.ts";
import type { QlooClient } from "./qloo/client.ts";
import { TransplantInputSchema, union } from "./transplant.ts";

export const RefineInputSchema = z.object({
  cityId: z.string().max(40),
  people: TransplantInputSchema.shape.people,
  hoods: z
    .array(z.object({ id: z.string().max(80), name: z.string().max(120) }))
    .min(1)
    .max(3),
  activeHoodId: z.string().max(80),
  message: z.string().trim().min(1).max(300),
});

export type RefineInput = z.infer<typeof RefineInputSchema>;

export type RefineAction = { type: "places"; hoodId: string; filters: string[]; places: Place[] } | { type: "focus"; hoodId: string };

export interface RefineResult {
  reply: string;
  actions: RefineAction[];
  trace: TraceStep[];
}

export interface RefineDeps {
  qloo: QlooClient;
  providers: ToolProvider[];
  hoodsFor: (city: City) => Hood[];
}

const MAX_TAGS = 3;

const SYSTEM = `You are the local guide inside Transplant, an app that found neighborhoods matching the user's cultural taste using Qloo.
The first part of the user message is JSON with the city, the user's neighborhoods (hoodId + name), the active one, and what they love.
Help them refine, e.g. "quieter", "more nightlife", "great coffee", "good for kids".
- To filter by a quality: call find_tags with a short phrase, choose the best-fitting tag ids from its results (ONLY ids it returned), then call find_places for the relevant hood.
- Qloo tag coverage is uneven. If find_places returns no places, call find_tags again with a more concrete venue word (e.g. "night club", "cocktail bar", "live music venue") and retry once before answering.
- Only use hoodIds from the JSON. Call focus_hood when they want to switch neighborhood.
- Reply in at most 60 words of plain text, naming 2-3 places that find_places returned. Never invent places or facts. If nothing fits, say so and suggest another phrasing.`;

const stringArray = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export async function refine(input: RefineInput, deps: RefineDeps): Promise<RefineResult> {
  const city = CITIES.find((c) => c.id === input.cityId);
  if (!city) return { reply: "Transplant doesn't cover that city yet.", actions: [], trace: [] };
  const shownIds = new Set(input.hoods.map((h) => h.id));
  const hoods = new Map(
    deps
      .hoodsFor(city)
      .filter((h) => shownIds.has(h.id))
      .map((h) => [h.id, h]),
  );
  const knownTags = new Map<string, string>();
  const actions = new Map<string, RefineAction>();
  let placesFound = 0;
  let lastEmpty: { hood: string; filters: string[] } | undefined;

  const hoodFor = (value: unknown) => {
    const hood = typeof value === "string" ? hoods.get(value) : undefined;
    if (!hood) throw new Error(`hood_id is not one of the user's neighborhoods (${[...hoods.keys()].join(", ")})`);
    return hood;
  };
  const tagsFrom = (value: unknown) =>
    stringArray(value)
      .slice(0, MAX_TAGS)
      .map((id) => {
        if (!knownTags.has(id)) throw new Error(`Unknown tag id ${id}; call find_tags first and use its ids`);
        return id;
      });

  const tools: AgentTool[] = [
    {
      spec: {
        name: "find_tags",
        description: "Search Qloo's tag ontology for place qualities (ambience, noise, good-for, cuisine, genre). Returns tag ids and names.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Short phrase, e.g. 'quiet' or 'live music'" } },
          required: ["query"],
        },
      },
      async run(args) {
        const query = String(args.query ?? "").slice(0, 60);
        const tags = await searchTags(deps.qloo, query, { take: 6, parentType: "urn:entity:place" });
        for (const t of tags) knownTags.set(t.id, t.name);
        const names = [...new Set(tags.map((t) => t.name))];
        return {
          result: tags.map(({ id, name, type }) => ({ id, name, kind: type.replace(/^urn:tag:/, "").split(":")[0] })),
          summary: `Qloo tags for "${query}": ${names.join(", ") || "none"}`,
        };
      },
    },
    {
      spec: {
        name: "find_places",
        description: "Find taste-matched places in one of the user's neighborhoods, optionally requiring or excluding Qloo tag ids.",
        parameters: {
          type: "object",
          properties: {
            hood_id: { type: "string" },
            include_tags: { type: "array", items: { type: "string" } },
            exclude_tags: { type: "array", items: { type: "string" } },
          },
          required: ["hood_id"],
        },
      },
      async run(args) {
        const hood = hoodFor(args.hood_id);
        const includeTags = tagsFrom(args.include_tags);
        const excludeTags = tagsFrom(args.exclude_tags);
        const places = curatePlaces(await placesNear(deps.qloo, union(input.people), hood, { includeTags, excludeTags }), 6);
        const filters = [...includeTags.map((id) => knownTags.get(id)!), ...excludeTags.map((id) => `not ${knownTags.get(id)!}`)];
        const summary = `${places.length} places in ${hood.name}${filters.length > 0 ? ` · ${filters.join(", ")}` : ""}`;
        if (places.length === 0) {
          lastEmpty = { hood: hood.name, filters };
          return {
            result: {
              places: [],
              note: `No places in ${hood.name} carry these Qloo tags. Do not name any place. Try other tag ids from find_tags (a different kind) or fewer tags.`,
            },
            summary,
          };
        }
        placesFound += places.length;
        actions.set(`places:${hood.id}`, { type: "places", hoodId: hood.id, filters, places });
        return { result: { places: places.map((p) => ({ placeId: p.id, name: p.name, label: placeLabel(p) })) }, summary };
      },
    },
    {
      spec: {
        name: "focus_hood",
        description: "Switch the neighborhood the user is looking at.",
        parameters: { type: "object", properties: { hood_id: { type: "string" } }, required: ["hood_id"] },
      },
      async run(args) {
        const hood = hoodFor(args.hood_id);
        actions.set("focus", { type: "focus", hoodId: hood.id });
        return { result: { ok: true }, summary: `Switched to ${hood.name}` };
      },
    },
  ];

  const context = {
    city: city.name,
    hoods: input.hoods.filter((h) => hoods.has(h.id)).map((h) => ({ hoodId: h.id, name: h.name })),
    activeHoodId: input.activeHoodId,
    loves: input.people.flatMap((p) => p.names),
  };
  const { reply, trace } = await runAgent({
    providers: deps.providers,
    system: SYSTEM,
    prompt: `${JSON.stringify(context)}\n\nUser: ${input.message}`,
    tools,
  });
  if (lastEmpty && placesFound === 0) {
    const what = lastEmpty.filters.length > 0 ? `${lastEmpty.filters.join(", ")} spots` : "matching spots";
    return {
      reply: `I couldn't find ${what} in ${lastEmpty.hood} in Qloo's data. Try another angle, like "cocktail bars", "live music", or "late-night food".`,
      actions: [...actions.values()],
      trace,
    };
  }
  return { reply, actions: [...actions.values()], trace };
}
