/**
 * Transplant as an MCP server (stateless Streamable HTTP, JSON responses), so any agent — Claude, an IDE
 * assistant, a travel bot — can ask "where in this city would this person feel at home?" and get answers
 * grounded in Qloo's taste graph. Same pipeline and guards as the web app.
 */
import { z } from "zod";
import { encodeShare } from "./share.ts";
import { CITIES } from "./cities.ts";
import { refine } from "./refine.ts";
import { type Chip, type ChipOption, resolveTaste } from "./resolve.ts";
import type { Place } from "./qloo/api.ts";
import type { RankedHood, Story } from "./story.ts";
import { runTransplant, type TransplantEvent, type TransplantInput } from "./transplant.ts";
import type { AppDeps } from "./app.ts";

const PROTOCOL = "2025-06-18";
const cityIds = CITIES.map((c) => c.id);

const TOOLS = [
  {
    name: "list_cities",
    description: "List the cities Transplant covers (id and name). Beta cities have thinner Qloo signal.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "find_neighborhoods",
    description:
      "Find the neighborhoods in a city where people with this person's cultural taste over-index, using Qloo's taste graph (heatmaps adjusted for popularity). Returns the top 3 neighborhoods with evidence, taste-matched local spots, a first-week plan, and a link to the interactive map. Pass the person's loves as free text: artists, TV shows, films, books, brands, kinds of places. For two people moving together, also pass partner_loves.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", enum: cityIds },
        loves: { type: "string", description: "e.g. 'Khruangbin, Fleabag, natural wine bars, Aesop' — at least 3 things" },
        partner_loves: { type: "string", description: "Optional: the other person's loves, to blend two tastes" },
        mode: { type: "string", enum: ["moving", "visiting"], default: "moving" },
      },
      required: ["city", "loves"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "ask_local_guide",
    description:
      "Refine spots in one neighborhood for this taste with a request like 'quieter', 'more nightlife' or 'great coffee'. A tool-using agent searches Qloo tags and places live; it never invents places.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", enum: cityIds },
        neighborhood: { type: "string", description: "Neighborhood name, e.g. one returned by find_neighborhoods" },
        loves: { type: "string" },
        request: { type: "string" },
      },
      required: ["city", "neighborhood", "loves", "request"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

const FindArgs = z.object({
  city: z.enum(cityIds as [string, ...string[]]),
  loves: z.string().min(1).max(600),
  partner_loves: z.string().max(600).optional(),
  mode: z.enum(["moving", "visiting"]).default("moving"),
});
const GuideArgs = z.object({
  city: z.enum(cityIds as [string, ...string[]]),
  neighborhood: z.string().min(1).max(120),
  loves: z.string().min(1).max(600),
  request: z.string().min(1).max(300),
});

class ToolError extends Error {}

/** Resolved picks; ambiguous items take Qloo's top match and are reported back so the caller can correct them. */
function picksFrom(chips: Chip[]): { picks: ChipOption[]; assumed: string[]; missing: string[] } {
  const picks: ChipOption[] = [];
  const assumed: string[] = [];
  const missing: string[] = [];
  for (const c of chips) {
    const pick = c.selected ?? c.options[0];
    if (!pick) missing.push(c.query);
    else {
      picks.push(pick);
      if (!c.selected) assumed.push(`"${c.query}" → ${pick.name} (${pick.type})`);
    }
  }
  return { picks, assumed, missing };
}

const person = (label: string, picks: ChipOption[]) => ({
  label,
  names: picks.map((o) => o.name).slice(0, 15),
  entities: picks.filter((o) => o.kind === "entity").map((o) => o.id).slice(0, 10),
  tags: picks.filter((o) => o.kind === "concept").map((o) => o.id).slice(0, 5),
  loves: picks.map((o) => ({ name: o.name, type: o.kind === "concept" ? "tag" : o.type })).slice(0, 15),
});

async function resolvePerson(deps: AppDeps, label: string, text: string) {
  const { picks, assumed, missing } = picksFrom(await resolveTaste(text, deps));
  if (picks.filter((p) => p.kind === "entity").length + picks.filter((p) => p.kind === "concept").length < 3)
    throw new ToolError(`Need at least 3 things ${label === "You" ? "the person" : label} loves that Qloo recognizes; found ${picks.length}.${missing.length ? ` Not in Qloo: ${missing.join(", ")}.` : ""}`);
  return { input: person(label, picks), picks, assumed, missing };
}

async function findNeighborhoods(deps: AppDeps, args: z.infer<typeof FindArgs>, origin: string) {
  const a = await resolvePerson(deps, "You", args.loves);
  const b = args.partner_loves ? await resolvePerson(deps, "Them", args.partner_loves) : undefined;
  const input: TransplantInput = { cityId: args.city, mode: args.mode, people: b ? [a.input, b.input] : [a.input] };
  let hoods: RankedHood[] = [];
  let places: Place[] = [];
  let story: Story | undefined;
  let shared: string[] = [];
  let failure: string | undefined;
  await runTransplant(input, deps, (e: TransplantEvent) => {
    if (e.type === "hoods") hoods = e.hoods;
    if (e.type === "places") places = e.places;
    if (e.type === "story") story = e.story;
    if (e.type === "shared") shared = e.tags.map((t) => t.name);
    if (e.type === "error") failure = e.message;
  });
  if (failure) throw new ToolError(failure);
  const city = CITIES.find((c) => c.id === args.city)!;
  const link = `${origin}/?t=${encodeShare({ cityId: args.city, mode: args.mode, people: [{ label: "You", picks: a.picks }, ...(b ? [{ label: "Them", picks: b.picks }] : [])] })}`;
  const result = {
    city: city.name,
    understoodAs: [...a.picks, ...(b?.picks ?? [])].map((p) => `${p.name} (${p.kind === "concept" ? "style" : p.type})`),
    assumed: [...a.assumed, ...(b?.assumed ?? [])],
    notInQloo: [...a.missing, ...(b?.missing ?? [])],
    neighborhoods: hoods.map((h, i) => ({
      rank: i + 1,
      name: h.name,
      why: story?.hoods.find((s) => s.hoodId === h.id)?.why,
      tasteLift: Number((h.score * 100).toFixed(1)),
      evidenceCells: h.cellCount,
    })),
    sharedTastes: shared,
    spots: places.map((p) => ({ name: p.name, neighborhood: p.neighborhood, address: p.address, rating: p.rating })),
    plan: (story?.plan ?? []).map((p) => ({ when: p.when, place: places.find((x) => x.id === p.placeId)?.name, note: p.note })),
    interactiveMap: link,
  };
  const lines = [
    `Where this taste lives in ${city.name} (Qloo heatmaps, adjusted for popularity):`,
    ...result.neighborhoods.map((h) => `${h.rank}. ${h.name} — ${h.why ?? ""} (taste lift +${h.tasteLift}, ${h.evidenceCells} Qloo cells)`),
    result.spots.length ? `Spots in ${hoods[0]?.name}: ${result.spots.map((s) => s.name).join(", ")}` : "",
    result.assumed.length ? `Assumed: ${result.assumed.join("; ")}` : "",
    `Interactive map: ${link}`,
  ].filter(Boolean);
  return { text: lines.join("\n"), structured: result };
}

async function askGuide(deps: AppDeps, args: z.infer<typeof GuideArgs>) {
  const city = CITIES.find((c) => c.id === args.city)!;
  const want = args.neighborhood.trim().toLowerCase();
  const hood = deps.hoodsFor(city).find((h) => h.name.toLowerCase() === want);
  if (!hood) throw new ToolError(`"${args.neighborhood}" isn't a ${city.name} neighborhood Transplant knows. Use a name from find_neighborhoods.`);
  const { input } = await resolvePerson(deps, "You", args.loves);
  const out = await refine(
    { cityId: city.id, people: [input], hoods: [{ id: hood.id, name: hood.name }], activeHoodId: hood.id, message: args.request },
    { qloo: deps.qloo, providers: deps.tools, hoodsFor: deps.hoodsFor },
  );
  const spots = out.actions.flatMap((a) => (a.type === "places" ? a.places.map((p) => ({ name: p.name, neighborhood: p.neighborhood, address: p.address })) : []));
  const filters = out.actions.flatMap((a) => (a.type === "places" ? a.filters : []));
  return {
    text: `${out.reply}\n\nQloo calls: ${out.trace.map((t) => t.summary).join(" → ")}`,
    structured: { reply: out.reply, qlooFilters: filters, spots, trace: out.trace },
  };
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

export async function handleMcp(
  body: unknown,
  deps: AppDeps,
  ctx: { ip: string; origin: string },
): Promise<{ status: number; json?: unknown }> {
  const msg = body as Rpc;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return { status: 400, json: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } } };
  if (msg.id === undefined) return { status: 202 }; // notification
  const reply = (result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id: msg.id, result } });
  const fail = (code: number, message: string) => ({ status: 200, json: { jsonrpc: "2.0", id: msg.id, error: { code, message } } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "transplant", title: "Transplant — where your taste lives", version: "0.2.0" },
        instructions:
          "Use find_neighborhoods when someone is moving to or visiting a city and you know some of their cultural tastes. Results come from Qloo's taste graph; share the interactiveMap link with the user.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === "list_cities") {
          const cities = CITIES.map((c) => ({ id: c.id, name: c.name, beta: c.beta === true }));
          return reply({ content: [{ type: "text", text: cities.map((c) => `${c.id}: ${c.name}${c.beta ? " (beta)" : ""}`).join("\n") }], structuredContent: { cities } });
        }
        if (name === "find_neighborhoods") {
          const parsed = FindArgs.safeParse(args);
          if (!parsed.success) throw new ToolError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
          if (!deps.limits.transplant.allow(ctx.ip)) throw new ToolError("Rate limit reached for this hour. Try again later.");
          const out = await findNeighborhoods(deps, parsed.data, ctx.origin);
          return reply({ content: [{ type: "text", text: out.text }], structuredContent: out.structured });
        }
        if (name === "ask_local_guide") {
          const parsed = GuideArgs.safeParse(args);
          if (!parsed.success) throw new ToolError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
          if (!deps.limits.refine.allow(ctx.ip)) throw new ToolError("Rate limit reached for this hour. Try again later.");
          const out = await askGuide(deps, parsed.data);
          return reply({ content: [{ type: "text", text: out.text }], structuredContent: out.structured });
        }
        return fail(-32602, `Unknown tool ${String(name)}`);
      } catch (error) {
        const text = error instanceof ToolError ? error.message : "Transplant couldn't complete that right now (Qloo or the language model is busy). Try again shortly.";
        if (!(error instanceof ToolError)) console.error(error);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
