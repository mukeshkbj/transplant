# Transplant M2 — Backend API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans (or subagent-driven-development) to implement task-by-task.

**Goal:** A running HTTP API that turns free-text taste into confirmed Qloo chips and streams a full Transplant result (ranked neighborhoods, map cells, curated local places, grounded story) for one person or a blended pair.

**Architecture:** Hono on Node. `POST /api/resolve` uses the LLM only to extract items from free text, then Qloo `/search` (entities) or `/v2/tags` (concepts) to build chips with alternatives. `POST /api/transplant` runs a deterministic pipeline: heatmap per person → taste lift → neighborhood scoring/blend → Qloo places around the top hood → LLM story constrained to evidence, streamed over Server-Sent Events. Qloo access is `withCache(withQuotaGuard(createQlooClient()))`, so cached answers never spend quota and live calls stop at a floor. LLM: Gemini flash-lite first, Groq fallback, template copy if both fail.

**Tech Stack:** Hono 4.13.11, @hono/node-server 2.1.3, zod 4.6.5 (all published ≥7 days ago), plus M1's TypeScript 7 / Vitest 5 / tsx / `node:sqlite`.

**Verified on 2026-10-05 (fixtures saved in `server/test/fixtures/`):**
- `/search?query=Aesop&types=urn:entity:brand&take=3` → `results[].{entity_id,name,types,popularity,properties.image.url,properties.short_description}`. Untyped search ranks the *author* first, so the LLM type hint is required.
- `/v2/tags?filter.query=natural wine bars` → `results.tags[].{id,name,type}`. Tag IDs work as `signal.interests.tags` in heatmaps (adds `tag_affinity`).
- Places: `filter.location.query="Greenpoint, New York City"` did **not** constrain results (returned Manhattan). `filter.location=POINT(lng lat)` + `filter.location.radius=1200` did: Desert Island, Brooklyn Steel, Land to Sea, plus noise like a wastewater plant. Each place has `properties.primary_genre.id`, category tags (`urn:tag:category:place`), `properties.images[0].url`, `properties.neighborhood`, `location.{lat,lon}`, `query.affinity`.
- `/v2/analysis/compare` → `results.tags[].{tag_id,name,query.score}`.
- Gemini `generationConfig.responseJsonSchema` and Groq `response_format.json_schema` (strict) both return schema-valid JSON for the extraction schema.

**Ground rules:**
- Never print, log, or commit secrets. Error messages name env vars, never values.
- Unit tests make zero network calls: Qloo via `server/test/fakes.ts`, LLM via fake providers.
- LLM schemas use `z.strictObject`, every field required, no min/max constraints (Groq strict mode). Enforce limits in code after parsing.
- Run from `D:\Qloo` in Git Bash. After each task: `npx vitest run && npm run typecheck`.

---

### Task 1: Dependencies and scripts

**Files:** Modify `package.json`.

**Step 1: Install**

Run: `npm install --save-exact hono@4.13.11 @hono/node-server@2.1.3 zod@4.6.5`
Expected: `added N packages`, 0 vulnerabilities.

**Step 2: Add scripts** to `package.json` `"scripts"`:

```json
"dev": "node --env-file-if-exists=.env --watch --import tsx server/src/main.ts",
"start": "node --env-file-if-exists=.env --import tsx server/src/main.ts",
```

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add Hono, node-server, and zod for the M2 API"
```

---

### Task 2: Config

**Files:** Create `server/src/config.ts`; Test `server/src/config.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ QLOO_API_KEY: "q", GEMINI_API_KEY: "g" });

    expect(config).toMatchObject({
      QLOO_BASE_URL: "https://hackathon.api.qloo.com",
      GEMINI_MODEL: "gemini-3.5-flash-lite",
      GROQ_MODEL: "openai/gpt-oss-120b",
      PORT: 8787,
      CACHE_PATH: ".cache/qloo.sqlite",
      QUOTA_FLOOR: 1500,
    });
  });

  it("names missing variables without echoing any values", () => {
    expect(() => loadConfig({ GEMINI_API_KEY: "secret-value" })).toThrow(/QLOO_API_KEY/);
    expect(() => loadConfig({ GEMINI_API_KEY: "secret-value" })).not.toThrow(/secret-value/);
  });
});
```

**Step 2: Run** `npx vitest run server/src/config.test.ts` → FAIL (module missing).

**Step 3: Implement**

```ts
import { z } from "zod";

const Env = z.object({
  QLOO_API_KEY: z.string().min(1),
  QLOO_BASE_URL: z.url().default("https://hackathon.api.qloo.com"),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  PORT: z.coerce.number().int().default(8787),
  CACHE_PATH: z.string().default(".cache/qloo.sqlite"),
  QUOTA_FLOOR: z.coerce.number().int().default(1500),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}
```

**Step 4: Run** → PASS (2). Typecheck clean.

**Step 5: Commit** `git add server/src/config* && git commit -m "Add validated env config that never echoes secrets"`

---

### Task 3: Quota guard

**Files:** Create `server/src/qloo/quota.ts`; Test `server/src/qloo/quota.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import type { QlooClient } from "./client.ts";
import { QuotaLowError, withQuotaGuard } from "./quota.ts";

const inner = (remaining: number | undefined) => {
  const get = vi.fn(async () => ({ data: {}, monthRemaining: remaining }));
  return { client: { get } as unknown as QlooClient, get };
};

describe("withQuotaGuard", () => {
  it("records the latest monthly remaining count", async () => {
    const state = { remaining: undefined as number | undefined };
    await withQuotaGuard(inner(9000).client, 1500, state).get("/search", {});

    expect(state.remaining).toBe(9000);
  });

  it("refuses live calls once remaining drops below the floor", async () => {
    const { client, get } = inner(1499);
    const guarded = withQuotaGuard(client, 1500);

    await guarded.get("/search", {});
    await expect(guarded.get("/search", {})).rejects.toBeInstanceOf(QuotaLowError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("ignores responses without a quota header", async () => {
    const state = { remaining: 5000 as number | undefined };
    await withQuotaGuard(inner(undefined).client, 1500, state).get("/search", {});

    expect(state.remaining).toBe(5000);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

```ts
import { type QlooClient, QlooError, type QlooParams, type QlooResponse } from "./client.ts";

export interface QuotaState {
  remaining: number | undefined;
}

export class QuotaLowError extends QlooError {
  constructor(floor: number) {
    super(`Qloo monthly quota is below ${floor}; only cached results are available`, 429, false);
    this.name = "QuotaLowError";
  }
}

export function withQuotaGuard(inner: QlooClient, floor: number, state: QuotaState = { remaining: undefined }): QlooClient {
  return {
    async get<T>(path: string, params: QlooParams): Promise<QlooResponse<T>> {
      if (state.remaining !== undefined && state.remaining < floor) throw new QuotaLowError(floor);
      const res = await inner.get<T>(path, params);
      if (res.monthRemaining !== undefined) state.remaining = res.monthRemaining;
      return res;
    },
  };
}
```

Wiring order (Task 11): `withCache(withQuotaGuard(createQlooClient(...)))` so cache hits bypass the guard.

**Step 4: Run** → PASS (3).

**Step 5: Commit** `git add server/src/qloo/quota* && git commit -m "Add Qloo monthly quota guard"`

---

### Task 4: Test fakes

**Files:** Create `server/test/fakes.ts` (helpers only; not a test file).

```ts
import { readFileSync } from "node:fs";
import type { JsonRequest, Llm } from "../src/llm/llm.ts";
import type { QlooClient, QlooParams } from "../src/qloo/client.ts";

export const fixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

export type QlooRoute = (path: string, params: QlooParams) => unknown;

export function fakeQloo(route: QlooRoute) {
  const calls: { path: string; params: QlooParams }[] = [];
  const client: QlooClient = {
    async get<T>(path: string, params: QlooParams) {
      calls.push({ path, params });
      const data = route(path, params);
      if (data === undefined) throw new Error(`Unexpected Qloo call ${path} ${JSON.stringify(params)}`);
      return { data: data as T, monthRemaining: 9000 };
    },
  };
  return { client, calls };
}

export function fakeLlm(respond: (req: JsonRequest<unknown>) => unknown) {
  const requests: JsonRequest<unknown>[] = [];
  const llm: Llm = {
    async json<T>(req: JsonRequest<T>): Promise<T> {
      requests.push(req as JsonRequest<unknown>);
      return req.schema.parse(await respond(req as JsonRequest<unknown>));
    },
  };
  return { llm, requests };
}
```

It uses `import type` from `llm.ts` (created in Task 6). Vitest strips type-only imports, so Tasks 5 and 7 tests run before Task 6 exists; `npm run typecheck` will fail until Task 6. Commit it with Task 6.

---

### Task 5: Qloo domain API

**Files:** Create `server/src/qloo/api.ts`; Test `server/src/qloo/api.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fakeQloo, fixture } from "../../test/fakes.ts";
import { compareTastes, heatmap, placesNear, searchEntities, searchTags } from "./api.ts";

describe("Qloo domain API", () => {
  it("searchEntities sends a typed query and maps candidates", async () => {
    const { client, calls } = fakeQloo(() => fixture("search-aesop-brand.json"));

    const [aesop] = await searchEntities(client, "Aesop", "brand");

    expect(calls[0]).toEqual({ path: "/search", params: { query: "Aesop", take: 3, types: "urn:entity:brand" } });
    expect(aesop).toMatchObject({ name: "Aesop", type: "brand" });
    expect(aesop!.image).toMatch(/^https:\/\/images\.qloo\.com\//);
  });

  it("searchTags maps tag ids", async () => {
    const { client } = fakeQloo(() => fixture("tags-natural-wine-bars.json"));

    const tags = await searchTags(client, "natural wine bars");

    expect(tags[0]).toEqual({ id: expect.stringMatching(/^urn:tag:/), name: expect.any(String), type: expect.stringMatching(/^urn:tag:/) });
  });

  it("heatmap sends entity and tag signals with the city", async () => {
    const { client, calls } = fakeQloo(() => fixture("heatmap-indie-nyc.json"));

    const cells = await heatmap(client, { entities: ["E1"], tags: ["urn:tag:x"] }, "New York City");

    expect(calls[0]!.params).toEqual({
      "filter.type": "urn:heatmap",
      "signal.interests.entities": ["E1"],
      "signal.interests.tags": ["urn:tag:x"],
      "filter.location.query": "New York City",
      take: 50,
    });
    expect(cells.length).toBeGreaterThan(100);
  });

  it("placesNear filters by a lng-first WKT point and maps place details", async () => {
    const { client, calls } = fakeQloo(() => fixture("places-indie-greenpoint.json"));

    const places = await placesNear(client, { entities: ["E1"], tags: [] }, { lat: 40.73, lng: -73.95 });

    expect(calls[0]!.params).toMatchObject({ "filter.location": "POINT(-73.95 40.73)", "filter.location.radius": 1200, take: 30 });
    expect(places.find((p) => p.name === "Desert Island")).toMatchObject({
      genre: "urn:tag:genre:place:comic_book_store",
      categories: expect.arrayContaining(["Comic book store"]),
      neighborhood: "Williamsburg",
      closed: false,
    });
  });

  it("compareTastes maps shared tags and skips empty groups", async () => {
    const { client, calls } = fakeQloo(() => ({ results: { tags: [{ tag_id: "urn:tag:genre:music:blues", name: "Blues", query: { score: 0.98 } }] } }));

    expect(await compareTastes(client, { entities: ["A"], tags: [] }, { entities: ["B"], tags: [] })).toEqual([
      { id: "urn:tag:genre:music:blues", name: "Blues", score: 0.98 },
    ]);
    expect(await compareTastes(client, { entities: [], tags: ["t"] }, { entities: ["B"], tags: [] })).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

```ts
import { type HeatCell, parseHeatmap } from "../geo/heatmap.ts";
import type { QlooClient } from "./client.ts";

export const ENTITY_TYPES = ["artist", "book", "brand", "movie", "place", "podcast", "tv_show"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Candidate {
  id: string;
  name: string;
  type: string;
  image?: string;
  description?: string;
  popularity: number;
}

export interface TagCandidate {
  id: string;
  name: string;
  type: string;
}

export interface Signals {
  entities: string[];
  tags: string[];
}

export interface Place {
  id: string;
  name: string;
  genre: string;
  categories: string[];
  address?: string;
  neighborhood?: string;
  lat: number;
  lng: number;
  image?: string;
  rating?: number;
  affinity: number;
  description?: string;
  closed: boolean;
}

export interface SharedTag {
  id: string;
  name: string;
  score: number;
}

interface RawEntity {
  entity_id: string;
  name: string;
  types: string[];
  popularity?: number;
  properties?: { image?: { url?: string }; short_description?: string };
}

interface RawPlace {
  entity_id: string;
  name: string;
  location?: { lat?: number; lon?: number };
  query?: { affinity?: number };
  tags?: { name: string; type: string }[];
  properties?: {
    address?: string;
    neighborhood?: string;
    business_rating?: number;
    is_closed?: boolean;
    short_description?: string;
    images?: { url?: string }[];
    primary_genre?: { id?: string };
  };
}

const signalParams = ({ entities, tags }: Signals) => ({
  ...(entities.length > 0 ? { "signal.interests.entities": entities } : {}),
  ...(tags.length > 0 ? { "signal.interests.tags": tags } : {}),
});

export async function searchEntities(qloo: QlooClient, query: string, type?: EntityType, take = 3): Promise<Candidate[]> {
  const { data } = await qloo.get<{ results?: RawEntity[] }>("/search", {
    query,
    take,
    ...(type ? { types: `urn:entity:${type}` } : {}),
  });
  return (data.results ?? []).map((e) => ({
    id: e.entity_id,
    name: e.name,
    type: (e.types[0] ?? "").replace("urn:entity:", ""),
    image: e.properties?.image?.url,
    description: e.properties?.short_description,
    popularity: e.popularity ?? 0,
  }));
}

export async function searchTags(qloo: QlooClient, query: string, take = 3): Promise<TagCandidate[]> {
  const { data } = await qloo.get<{ results?: { tags?: TagCandidate[] } }>("/v2/tags", { "filter.query": query, take });
  return (data.results?.tags ?? []).map(({ id, name, type }) => ({ id, name, type }));
}

export async function heatmap(qloo: QlooClient, signals: Signals, cityQuery: string): Promise<HeatCell[]> {
  const { data } = await qloo.get<Parameters<typeof parseHeatmap>[0]>("/v2/insights", {
    "filter.type": "urn:heatmap",
    ...signalParams(signals),
    "filter.location.query": cityQuery,
    take: 50,
  });
  return parseHeatmap(data);
}

export async function placesNear(
  qloo: QlooClient,
  signals: Signals,
  at: { lat: number; lng: number },
  radiusM = 1200,
  take = 30,
): Promise<Place[]> {
  const { data } = await qloo.get<{ results?: { entities?: RawPlace[] } }>("/v2/insights", {
    "filter.type": "urn:entity:place",
    ...signalParams(signals),
    "filter.location": `POINT(${at.lng} ${at.lat})`,
    "filter.location.radius": radiusM,
    take,
  });
  return (data.results?.entities ?? []).map((e) => ({
    id: e.entity_id,
    name: e.name,
    genre: e.properties?.primary_genre?.id ?? "",
    categories: (e.tags ?? []).filter((t) => t.type === "urn:tag:category:place").map((t) => t.name),
    address: e.properties?.address,
    neighborhood: e.properties?.neighborhood,
    lat: e.location?.lat ?? 0,
    lng: e.location?.lon ?? 0,
    image: e.properties?.images?.[0]?.url,
    rating: e.properties?.business_rating,
    affinity: e.query?.affinity ?? 0,
    description: e.properties?.short_description,
    closed: e.properties?.is_closed === true,
  }));
}

export async function compareTastes(qloo: QlooClient, a: Signals, b: Signals, take = 8): Promise<SharedTag[]> {
  if (a.entities.length === 0 || b.entities.length === 0) return [];
  const { data } = await qloo.get<{ results?: { tags?: { tag_id: string; name: string; query?: { score?: number } }[] } }>(
    "/v2/analysis/compare",
    { "a.signal.interests.entities": a.entities, "b.signal.interests.entities": b.entities, take },
  );
  return (data.results?.tags ?? []).map((t) => ({ id: t.tag_id, name: t.name, score: t.query?.score ?? 0 }));
}
```

**Step 4: Run** `npx vitest run server/src/qloo/api.test.ts` → PASS (5). Skip typecheck until Task 6 (see Task 4 note).

**Step 5: Commit** after Task 6 (shared fakes dependency).

---

### Task 6: LLM layer with fallback

**Files:** Create `server/src/llm/llm.ts`, `server/src/llm/providers.ts`; Tests `server/src/llm/llm.test.ts`, `server/src/llm/providers.test.ts`.

**Step 1: Failing tests**

`server/src/llm/llm.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlm, jsonSchemaOf, LlmError, type LlmProvider } from "./llm.ts";

const Schema = z.strictObject({ answer: z.string() });
const provider = (name: string, result: () => Promise<unknown>): LlmProvider => ({ name, json: vi.fn(result) });
const req = { schema: Schema, system: "s", prompt: "p", name: "test" };

describe("jsonSchemaOf", () => {
  it("emits a strict object schema without $schema", () => {
    const schema = jsonSchemaOf(Schema);

    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({ type: "object", required: ["answer"], additionalProperties: false });
  });
});

describe("createLlm", () => {
  it("returns the first provider's valid answer", async () => {
    const llm = createLlm([provider("a", async () => ({ answer: "hi" }))], () => {});

    expect(await llm.json(req)).toEqual({ answer: "hi" });
  });

  it("falls back on provider errors and schema mismatches", async () => {
    const failing = provider("a", async () => Promise.reject(new Error("HTTP 503")));
    const wrong = provider("b", async () => ({ nope: 1 }));
    const good = provider("c", async () => ({ answer: "ok" }));
    const log = vi.fn();

    expect(await createLlm([failing, wrong, good], log).json(req)).toEqual({ answer: "ok" });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("throws LlmError when every provider fails", async () => {
    const llm = createLlm([provider("a", async () => Promise.reject(new Error("down")))], () => {});

    await expect(llm.json(req)).rejects.toBeInstanceOf(LlmError);
  });
});
```

`server/src/llm/providers.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { geminiProvider, groqProvider } from "./providers.ts";

const call = { system: "sys", prompt: "hello", jsonSchema: { type: "object" }, name: "x" };
const ok = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe("geminiProvider", () => {
  it("requests JSON with the schema and parses the text part", async () => {
    const fetchImpl = ok({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] });

    const result = await geminiProvider({ apiKey: "k", model: "m", fetchImpl }).json(call);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/m:generateContent");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("k");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      systemInstruction: { parts: [{ text: "sys" }] },
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
    });
    expect(result).toEqual({ a: 1 });
  });

  it("throws on HTTP errors without leaking the key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }));

    await expect(geminiProvider({ apiKey: "secret", model: "m", fetchImpl }).json(call)).rejects.toThrow(/503.*overloaded/);
    await expect(geminiProvider({ apiKey: "secret", model: "m", fetchImpl }).json(call)).rejects.not.toThrow(/secret/);
  });
});

describe("groqProvider", () => {
  it("requests strict json_schema output and parses the message", async () => {
    const fetchImpl = ok({ choices: [{ message: { content: '{"b":2}' } }] });

    const result = await groqProvider({ apiKey: "k", model: "gm", fetchImpl }).json(call);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gm",
      response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } },
    });
    expect(result).toEqual({ b: 2 });
  });
});
```

**Step 2: Run** `npx vitest run server/src/llm` → FAIL.

**Step 3: Implement**

`server/src/llm/llm.ts`:

```ts
import { z } from "zod";

export class LlmError extends Error {
  override name = "LlmError";
}

export interface JsonRequest<T> {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  name: string;
}

export interface ProviderCall {
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  name: string;
}

export interface LlmProvider {
  name: string;
  json(call: ProviderCall): Promise<unknown>;
}

export interface Llm {
  json<T>(req: JsonRequest<T>): Promise<T>;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function createLlm(providers: LlmProvider[], log: (message: string) => void = console.warn): Llm {
  return {
    async json<T>({ schema, system, prompt, name }: JsonRequest<T>): Promise<T> {
      const jsonSchema = jsonSchemaOf(schema);
      const failures: string[] = [];
      for (const provider of providers) {
        try {
          const parsed = schema.safeParse(await provider.json({ system, prompt, jsonSchema, name }));
          if (parsed.success) return parsed.data;
          failures.push(`${provider.name}: schema mismatch`);
        } catch (error) {
          failures.push(`${provider.name}: ${(error as Error).message}`);
        }
        log(`LLM fallback (${failures.at(-1)})`);
      }
      throw new LlmError(`All LLM providers failed: ${failures.join("; ")}`);
    },
  };
}
```

`server/src/llm/providers.ts`:

```ts
import type { LlmProvider, ProviderCall } from "./llm.ts";

interface ProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 20_000;

const failure = async (res: Response) => {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return new Error(`HTTP ${res.status}: ${(body.error?.message ?? "").slice(0, 160)}`);
};

export function geminiProvider({ apiKey, model, fetchImpl = fetch }: ProviderOptions): LlmProvider {
  return {
    name: `gemini:${model}`,
    async json({ system, prompt, jsonSchema }: ProviderCall) {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: jsonSchema, temperature: 0.4 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return JSON.parse(body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "");
    },
  };
}

export function groqProvider({ apiKey, model, fetchImpl = fetch }: ProviderOptions): LlmProvider {
  return {
    name: `groq:${model}`,
    async json({ system, prompt, jsonSchema, name }: ProviderCall) {
      const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } },
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return JSON.parse(body.choices?.[0]?.message?.content ?? "");
    },
  };
}
```

**Step 4: Run** `npx vitest run && npm run typecheck` → all PASS. If `jsonSchemaOf` doesn't emit `additionalProperties: false` for `z.strictObject`, inspect `z.toJSONSchema(Schema)` and adjust the implementation, not the test.

**Step 5: Commit**

```bash
git add server/test/fakes.ts server/src/qloo/api.ts server/src/qloo/api.test.ts server/src/llm
git commit -m "Add Qloo domain API and LLM layer with Gemini->Groq fallback"
```

---

### Task 7: Place curation

**Files:** Create `server/src/places.ts`; Test `server/src/places.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fakeQloo, fixture } from "../test/fakes.ts";
import { placesNear } from "./qloo/api.ts";
import { curatePlaces } from "./places.ts";

const load = async () => placesNear(fakeQloo(() => fixture("places-indie-greenpoint.json")).client, { entities: ["x"], tags: [] }, { lat: 0, lng: 0 });

describe("curatePlaces", () => {
  it("keeps taste-relevant venues and drops infrastructure, offices, and hotels", async () => {
    const names = curatePlaces(await load(), 30).map((p) => p.name);

    expect(names).toEqual(expect.arrayContaining(["Desert Island", "Land to Sea", "Brooklyn Steel", "Beacon's Closet"]));
    for (const banned of ["Newtown Creek Wastewater Treatment Plant", "JAVA STUDIOS", "The Greenpoint Loft", "Away", "Wythe Hotel"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("caps each genre at two and respects the limit, ordered by affinity", async () => {
    const curated = curatePlaces(await load(), 8);
    const counts = new Map<string, number>();
    for (const p of curated) counts.set(p.genre, (counts.get(p.genre) ?? 0) + 1);

    expect(curated.length).toBeLessThanOrEqual(8);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(curated.map((p) => p.affinity)).toEqual([...curated.map((p) => p.affinity)].sort((a, b) => b - a));
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

```ts
import type { Place } from "./qloo/api.ts";

const KEEP =
  /restaurant|cafe|coffee|tea|bakery|patisserie|dessert|ice_cream|(^|_)bar$|pub|brewery|winery|wine|book_store|comic|record|vintage|thrift|second_hand|boutique|clothing|flea_market|market|museum|gallery|art_center|live_music|theater|cinema|night_club|park|garden|spice|deli/;

export function curatePlaces(places: Place[], limit = 8, maxPerGenre = 2): Place[] {
  const perGenre = new Map<string, number>();
  return places
    .filter((p) => !p.closed && KEEP.test(p.genre.replace("urn:tag:genre:place:", "")))
    .sort((a, b) => b.affinity - a.affinity)
    .filter((p) => {
      const n = perGenre.get(p.genre) ?? 0;
      perGenre.set(p.genre, n + 1);
      return n < maxPerGenre;
    })
    .slice(0, limit);
}
```

**Step 4: Run** → PASS (2). If a "keep" name is missing, print `genre` for it and widen `KEEP` minimally.

**Step 5: Commit** `git add server/src/places* && git commit -m "Curate Qloo places to taste-relevant venues"`

---

### Task 8: Taste resolution (free text → chips)

**Files:** Create `server/src/resolve.ts`; Test `server/src/resolve.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fixture } from "../test/fakes.ts";
import { resolveTaste } from "./resolve.ts";

const qloo = fakeQloo((path, params) => {
  if (path === "/v2/tags") return fixture("tags-natural-wine-bars.json");
  if (params.query === "Aesop") return fixture("search-aesop-brand.json");
  if (params.query === "Lost") return { results: [
    { entity_id: "1", name: "Lost (2004)", types: ["urn:entity:tv_show"] },
    { entity_id: "2", name: "Lost Girl", types: ["urn:entity:tv_show"] },
  ] };
  if (params.query === "Zzyzx") return { results: [] };
  return undefined;
});

const llm = fakeLlm(() => ({
  items: [
    { query: "Aesop", kind: "entity", type: "brand" },
    { query: "natural wine bars", kind: "concept", type: "place" },
    { query: "Lost", kind: "entity", type: "tv_show" },
    { query: "Zzyzx", kind: "entity", type: "artist" },
  ],
}));

describe("resolveTaste", () => {
  it("builds resolved, concept, ambiguous, and missing chips", async () => {
    const chips = await resolveTaste("Aesop, natural wine bars, Lost, Zzyzx", { qloo: qloo.client, llm: llm.llm });

    expect(chips.map((c) => [c.query, c.kind, c.status])).toEqual([
      ["Aesop", "entity", "resolved"],
      ["natural wine bars", "concept", "resolved"],
      ["Lost", "entity", "ambiguous"],
      ["Zzyzx", "entity", "missing"],
    ]);
    expect(chips[0]!.selected).toMatchObject({ name: "Aesop", type: "brand", kind: "entity" });
    expect(chips[1]!.selected!.id).toMatch(/^urn:tag:/);
    expect(chips[2]!.options).toHaveLength(2);
    expect(chips[2]!.selected).toBeUndefined();
  });

  it("sends the user's text only to the LLM, and only extracted names to Qloo", async () => {
    await resolveTaste("my name is Ana; Aesop", { qloo: qloo.client, llm: llm.llm });

    expect(llm.requests.at(-1)!.prompt).toBe("my name is Ana; Aesop");
    expect(qloo.calls.every((c) => !JSON.stringify(c.params).includes("Ana"))).toBe(true);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

```ts
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
```

**Step 4: Run** → PASS (2).

**Step 5: Commit** `git add server/src/resolve* && git commit -m "Resolve free-text taste into confirmable Qloo chips"`

---

### Task 9: Hood data loader and story writer

**Files:** Create `server/src/hoods-data.ts`, `server/src/story.ts`; Test `server/src/story.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fakeLlm } from "../test/fakes.ts";
import type { Place } from "./qloo/api.ts";
import { type RankedHood, writeStory } from "./story.ts";

const hoods: RankedHood[] = [
  { id: "h1", name: "Greenpoint", lat: 0, lng: 0, score: 0.04, cellCount: 13, byType: [{ artist: 0.9, tv_show: 0.95 }], perPerson: [0.04] },
];
const places = [
  { id: "p1", name: "Desert Island", categories: ["Comic book store"], neighborhood: "Williamsburg" },
  { id: "p2", name: "Land to Sea", categories: ["Cafe"], neighborhood: "Williamsburg" },
] as Place[];
const base = { city: "New York City", mode: "moving" as const, people: [{ label: "You", names: ["Khruangbin"] }], hoods, places, shared: [] };

describe("writeStory", () => {
  it("passes evidence as JSON and drops ids the evidence doesn't contain", async () => {
    const { llm, requests } = fakeLlm(() => ({
      hoods: [
        { hoodId: "h1", headline: "Your crate-digging corner", why: "Fans of Khruangbin over-index here." },
        { hoodId: "ghost", headline: "x", why: "y" },
      ],
      plan: [
        { when: "Day 1", placeId: "p1", note: "Browse zines" },
        { when: "Day 2", placeId: "invented", note: "nope" },
      ],
    }));

    const { story, source } = await writeStory({ ...base, llm });

    expect(JSON.parse(requests[0]!.prompt)).toMatchObject({ city: "New York City", hoods: [{ hoodId: "h1" }], places: [{ placeId: "p1" }, { placeId: "p2" }] });
    expect(source).toBe("llm");
    expect(story.hoods.map((h) => h.hoodId)).toEqual(["h1"]);
    expect(story.plan.map((p) => p.placeId)).toEqual(["p1"]);
  });

  it("falls back to evidence-only template copy when the LLM fails", async () => {
    const { llm } = fakeLlm(() => {
      throw new Error("down");
    });

    const { story, source } = await writeStory({ ...base, llm });

    expect(source).toBe("template");
    expect(story.hoods[0]).toMatchObject({ hoodId: "h1", headline: "Greenpoint" });
    expect(story.hoods[0]!.why).toMatch(/TV/);
    expect(story.plan.map((p) => [p.when, p.placeId])).toEqual([["Day 1", "p1"], ["Day 2", "p2"]]);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`server/src/hoods-data.ts`:

```ts
import { readFileSync } from "node:fs";
import type { City } from "./cities.ts";
import type { Hood } from "./geo/hoods.ts";

const cache = new Map<string, Hood[]>();

export function loadHoods(city: City): Hood[] {
  const cached = cache.get(city.id);
  if (cached) return cached;
  const all = JSON.parse(readFileSync(new URL(`../data/hoods/${city.id}.json`, import.meta.url), "utf8")) as Hood[];
  const hoods = all.filter((h) => city.hoodKinds.includes(h.kind ?? ""));
  cache.set(city.id, hoods);
  return hoods;
}
```

`server/src/story.ts`:

```ts
import { z } from "zod";
import type { Llm } from "./llm/llm.ts";
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
- plan: 5 entries using only placeIds from evidence. mode "moving": a first week ("Day 1".."Day 5") mixing a coffee spot, an evening out, and a weekend browse. mode "visiting": "Morning"/"Afternoon"/"Evening" stops.
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
    plan: places.slice(0, 5).map((p, i) => ({ when: slots[i]!, placeId: p.id, note: p.categories[0] ?? "Taste match" })),
  };
}

export async function writeStory({ llm, city, mode, people, hoods, places, shared }: StoryInput): Promise<{ story: Story; source: "llm" | "template" }> {
  const evidence = {
    city,
    mode,
    people,
    hoods: hoods.map((h) => ({ hoodId: h.id, name: h.name, score: Number(h.score.toFixed(3)), byType: h.byType })),
    places: places.map((p) => ({ placeId: p.id, name: p.name, categories: p.categories, neighborhood: p.neighborhood })),
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
```

**Step 4: Run** → PASS (2).

**Step 5: Commit** `git add server/src/hoods-data.ts server/src/story* && git commit -m "Add hood loader and evidence-constrained story writer"`

---

### Task 10: Transplant pipeline

**Files:** Create `server/src/transplant.ts`; Test `server/src/transplant.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fixture } from "../test/fakes.ts";
import { loadHoods } from "./hoods-data.ts";
import { runTransplant, type TransplantEvent, type TransplantInput } from "./transplant.ts";

const person = (label: string) => ({ label, names: ["Khruangbin", "Fleabag", "Aesop"], entities: ["a", "b", "c"], tags: [] });

const setup = (heatmaps: string[], llmOk = true) => {
  const queue = heatmaps.map((name) => fixture(name));
  const qloo = fakeQloo((path, params) => {
    if (path === "/v2/insights" && params["filter.type"] === "urn:heatmap") return queue.shift();
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    if (path === "/v2/analysis/compare") return { results: { tags: [{ tag_id: "urn:tag:genre:music:blues", name: "Blues", query: { score: 0.98 } }] } };
    return undefined;
  });
  const { llm } = fakeLlm((req) => {
    if (!llmOk) throw new Error("down");
    const evidence = JSON.parse(req.prompt);
    return {
      hoods: evidence.hoods.map((h: { hoodId: string }) => ({ hoodId: h.hoodId, headline: "h", why: "w" })),
      plan: [{ when: "Day 1", placeId: evidence.places[0].placeId, note: "n" }, { when: "Day 2", placeId: "invented", note: "n" }],
    };
  });
  return { deps: { qloo: qloo.client, llm, hoodsFor: loadHoods }, calls: qloo.calls };
};

const run = async (input: TransplantInput, deps: ReturnType<typeof setup>["deps"]) => {
  const events: TransplantEvent[] = [];
  await runTransplant(input, deps, (e) => events.push(e));
  return events;
};

const find = <K extends TransplantEvent["type"]>(events: TransplantEvent[], type: K) =>
  events.find((e): e is Extract<TransplantEvent, { type: K }> => e.type === type)!;

describe("runTransplant", () => {
  it("streams ranked hoods, curated places near the top hood, and a grounded story", async () => {
    const { deps, calls } = setup(["heatmap-indie-nyc.json"]);

    const events = await run({ cityId: "nyc", mode: "moving", people: [person("You")] }, deps);

    expect(events.filter((e) => e.type !== "step").map((e) => e.type)).toEqual(["hoods", "places", "story", "done"]);
    const { hoods, cells, signal } = find(events, "hoods");
    expect(hoods[0]!.name).toBe("Greenpoint");
    expect(hoods).toHaveLength(3);
    expect(cells.length).toBeGreaterThan(50);
    expect(signal.level).toBe("strong");
    expect(String(calls.find((c) => c.params["filter.type"] === "urn:entity:place")!.params["filter.location"])).toMatch(/^POINT\(-73\.9\d* 40\.7\d*\)$/);
    expect(find(events, "places").places.map((p) => p.name)).toContain("Desert Island");
    const story = find(events, "story");
    expect(story.source).toBe("llm");
    expect(story.story.plan.map((p) => p.placeId)).not.toContain("invented");
  });

  it("still delivers template copy when the LLM is down", async () => {
    const { deps } = setup(["heatmap-indie-nyc.json"], false);

    const story = find(await run({ cityId: "nyc", mode: "visiting", people: [person("You")] }, deps), "story");

    expect(story.source).toBe("template");
    expect(story.story.plan[0]!.when).toBe("Morning");
  });

  it("blends two people by their weaker score and reports shared tastes", async () => {
    const { deps } = setup(["heatmap-indie-nyc.json", "heatmap-mainstream-nyc.json"]);

    const events = await run({ cityId: "nyc", mode: "moving", people: [person("You"), person("Sam")] }, deps);

    const { hoods } = find(events, "hoods");
    expect(hoods[0]!.perPerson).toHaveLength(2);
    expect(hoods[0]!.score).toBeCloseTo(Math.min(...hoods[0]!.perPerson));
    expect(find(events, "shared").tags[0]!.name).toBe("Blues");
  });

  it("emits a typed error for an unknown city", async () => {
    const { deps } = setup([]);

    const events = await run({ cityId: "atlantis", mode: "moving", people: [person("You")] }, deps);

    expect(events).toEqual([{ type: "error", code: "UNKNOWN_CITY", message: expect.any(String) }]);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

```ts
import { z } from "zod";
import { type City, CITIES } from "./cities.ts";
import { type LiftCell, tasteLift } from "./geo/heatmap.ts";
import { blendHoods, type Hood, type HoodScore, scoreHoods } from "./geo/hoods.ts";
import type { Llm } from "./llm/llm.ts";
import { curatePlaces } from "./places.ts";
import { compareTastes, heatmap, type Place, placesNear, type SharedTag, type Signals } from "./qloo/api.ts";
import type { QlooClient } from "./qloo/client.ts";
import { type RankedHood, type Story, writeStory } from "./story.ts";

export const TransplantInputSchema = z.object({
  cityId: z.string().max(40),
  mode: z.enum(["moving", "visiting"]),
  people: z
    .array(
      z
        .object({
          label: z.string().max(40),
          names: z.array(z.string().max(120)).max(15),
          entities: z.array(z.string().max(80)).max(10),
          tags: z.array(z.string().max(120)).max(5),
        })
        .refine((p) => p.entities.length + p.tags.length >= 3, "Pick at least 3 things you love"),
    )
    .min(1)
    .max(2),
});

export type TransplantInput = z.infer<typeof TransplantInputSchema>;

export interface MapCell {
  lat: number;
  lng: number;
  lift: number;
}

export interface SignalStrength {
  level: "strong" | "moderate" | "weak";
  topScore: number;
  cells: number;
}

export type TransplantEvent =
  | { type: "step"; id: string; label: string; status: "running" | "done" }
  | { type: "hoods"; hoods: RankedHood[]; cells: MapCell[]; signal: SignalStrength }
  | { type: "shared"; tags: SharedTag[] }
  | { type: "places"; hoodId: string; places: Place[] }
  | { type: "story"; story: Story; source: "llm" | "template" }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export interface TransplantDeps {
  qloo: QlooClient;
  llm: Llm;
  hoodsFor: (city: City) => Hood[];
}

const TOP_HOODS = 3;
const MAX_CELLS = 400;

const toRanked = (s: HoodScore): RankedHood => ({
  id: s.hood.id,
  name: s.hood.name,
  lat: s.hood.lat,
  lng: s.hood.lng,
  score: s.lift,
  cellCount: s.cellCount,
  byType: [s.byType],
  perPerson: [s.lift],
});

function rankHoods(scores: HoodScore[][]): RankedHood[] {
  const [a = [], b] = scores;
  if (!b) return a.map(toRanked);
  const byId = new Map(b.map((s) => [s.hood.id, s]));
  return blendHoods(a, b).map((blend) => {
    const sa = a.find((s) => s.hood.id === blend.hood.id)!;
    const sb = byId.get(blend.hood.id)!;
    return { ...toRanked(sa), score: blend.score, cellCount: Math.min(sa.cellCount, sb.cellCount), byType: [sa.byType, sb.byType], perPerson: [blend.a, blend.b] };
  });
}

function mapCells(cells: LiftCell[][]): MapCell[] {
  const [a = [], b] = cells;
  const lookup = b ? new Map(b.map((c) => [c.geohash, c.lift])) : undefined;
  return a
    .flatMap((c) => {
      if (!lookup) return [{ lat: c.lat, lng: c.lng, lift: c.lift }];
      const other = lookup.get(c.geohash);
      return other === undefined ? [] : [{ lat: c.lat, lng: c.lng, lift: Math.min(c.lift, other) }];
    })
    .sort((x, y) => y.lift - x.lift)
    .slice(0, MAX_CELLS);
}

const strength = (top: RankedHood): SignalStrength => ({
  level: top.score >= 0.03 && top.cellCount >= 8 ? "strong" : top.score >= 0.015 ? "moderate" : "weak",
  topScore: top.score,
  cells: top.cellCount,
});

const union = (people: Signals[]): Signals => ({
  entities: [...new Set(people.flatMap((p) => p.entities))],
  tags: [...new Set(people.flatMap((p) => p.tags))],
});

export async function runTransplant(input: TransplantInput, deps: TransplantDeps, emit: (event: TransplantEvent) => void): Promise<void> {
  const city = CITIES.find((c) => c.id === input.cityId);
  if (!city) return emit({ type: "error", code: "UNKNOWN_CITY", message: `Transplant doesn't cover "${input.cityId}" yet.` });
  const hoods = deps.hoodsFor(city);
  const step = async <T>(id: string, label: string, work: () => Promise<T>): Promise<T> => {
    emit({ type: "step", id, label, status: "running" });
    const result = await work();
    emit({ type: "step", id, label, status: "done" });
    return result;
  };

  const lifted = await step("map", `Mapping where your taste lives in ${city.name}`, async () => {
    const out: LiftCell[][] = [];
    for (const person of input.people) out.push(tasteLift(await heatmap(deps.qloo, person, city.query)));
    return out;
  });
  const ranked = rankHoods(lifted.map((cells) => scoreHoods(cells, hoods))).slice(0, TOP_HOODS);
  const top = ranked[0];
  if (!top) return emit({ type: "error", code: "NO_SIGNAL", message: `Not enough Qloo taste signal in ${city.name} for these picks. Try adding more.` });
  emit({ type: "hoods", hoods: ranked, cells: mapCells(lifted), signal: strength(top) });

  const [first, second] = input.people;
  const shared =
    first && second ? await step("compare", "Finding what you both love", () => compareTastes(deps.qloo, first, second)) : [];
  if (second) emit({ type: "shared", tags: shared });

  const places = await step("places", `Finding your spots in ${top.name}`, async () =>
    curatePlaces(await placesNear(deps.qloo, union(input.people), top)),
  );
  emit({ type: "places", hoodId: top.id, places });

  const { story, source } = await step("story", "Writing your plan", () =>
    writeStory({ llm: deps.llm, city: city.name, mode: input.mode, people: input.people.map(({ label, names }) => ({ label, names })), hoods: ranked, places, shared }),
  );
  emit({ type: "story", story, source });
  emit({ type: "done" });
}
```

**Step 4: Run** → PASS (4). If the top hood isn't Greenpoint, compare with `npm run lift-report` (same fixture and defaults); they must agree.

**Step 5: Commit** `git add server/src/transplant* && git commit -m "Add streaming Transplant pipeline with blend and grounded story"`

---

### Task 11: HTTP app, rate limiting, server entry

**Files:** Create `server/src/rate-limit.ts`, `server/src/app.ts`, `server/src/main.ts`; Test `server/src/app.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fixture } from "../test/fakes.ts";
import { createApp } from "./app.ts";
import { loadHoods } from "./hoods-data.ts";
import { createRateLimiter } from "./rate-limit.ts";

const deps = (limit = 10) => ({
  qloo: fakeQloo((path, params) => {
    if (path === "/search") return fixture("search-aesop-brand.json");
    if (params["filter.type"] === "urn:heatmap") return fixture("heatmap-indie-nyc.json");
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    return undefined;
  }).client,
  llm: fakeLlm((req) => (req.name === "taste_items" ? { items: [{ query: "Aesop", kind: "entity", type: "brand" }] } : Promise.reject(new Error("down")))).llm,
  quota: { remaining: 9000 as number | undefined },
  hoodsFor: loadHoods,
  limits: { resolve: createRateLimiter(limit, 60_000), transplant: createRateLimiter(limit, 60_000) },
});

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const transplantBody = { cityId: "nyc", mode: "moving", people: [{ label: "You", names: ["a"], entities: ["a", "b", "c"], tags: [] }] };

describe("createApp", () => {
  it("reports health and cities", async () => {
    const app = createApp(deps());

    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true, qlooMonthRemaining: 9000 });
    expect(await (await app.request("/api/cities")).json()).toEqual(expect.arrayContaining([{ id: "nyc", name: "New York City" }]));
  });

  it("resolves taste text into chips and rejects bad bodies", async () => {
    const app = createApp(deps());

    const ok = await app.request("/api/resolve", post({ text: "Aesop" }));
    expect((await ok.json()).chips[0]).toMatchObject({ query: "Aesop", status: "resolved" });
    expect((await app.request("/api/resolve", post({ text: "" }))).status).toBe(400);
  });

  it("streams transplant events as SSE", async () => {
    const res = await createApp(deps()).request("/api/transplant", post(transplantBody));

    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    for (const event of ["hoods", "places", "story", "done"]) expect(text).toContain(`event: ${event}`);
  });

  it("rate-limits per client IP", async () => {
    const app = createApp(deps(1));
    const req = () => app.request("/api/resolve", { ...post({ text: "Aesop" }), headers: { "content-type": "application/json", "fly-client-ip": "1.2.3.4" } });

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`server/src/rate-limit.ts`:

```ts
export interface RateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(limit: number, windowMs: number, now = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      const allowed = recent.length < limit;
      if (allowed) recent.push(t);
      hits.set(key, recent);
      return allowed;
    },
  };
}
```

`server/src/app.ts`:

```ts
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CITIES } from "./cities.ts";
import { LlmError } from "./llm/llm.ts";
import { QlooError } from "./qloo/client.ts";
import { QuotaLowError, type QuotaState } from "./qloo/quota.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { resolveTaste } from "./resolve.ts";
import { runTransplant, type TransplantDeps, type TransplantEvent, TransplantInputSchema } from "./transplant.ts";

export interface AppDeps extends TransplantDeps {
  quota: QuotaState;
  limits: { resolve: RateLimiter; transplant: RateLimiter };
}

const ResolveInput = z.object({ text: z.string().trim().min(1).max(600) });

const clientIp = (c: Context) =>
  c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

export function toPublicError(error: unknown): { code: string; message: string; status: 429 | 502 | 503 | 500 } {
  if (error instanceof QuotaLowError) return { code: "QUOTA_LOW", message: "Live Qloo lookups are paused to protect the event quota. Try a demo profile.", status: 503 };
  if (error instanceof QlooError) return { code: "QLOO_UNAVAILABLE", message: "Qloo is busy right now. Try again in a moment.", status: error.status === 429 ? 429 : 502 };
  if (error instanceof LlmError) return { code: "LLM_UNAVAILABLE", message: "Our language model is busy. Try again in a moment.", status: 503 };
  console.error(error);
  return { code: "INTERNAL", message: "Something went wrong.", status: 500 };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, qlooMonthRemaining: deps.quota.remaining ?? null }));
  app.get("/api/cities", (c) => c.json(CITIES.map(({ id, name }) => ({ id, name }))));

  app.post("/api/resolve", async (c) => {
    if (!deps.limits.resolve.allow(clientIp(c))) return c.json({ code: "RATE_LIMITED" }, 429);
    const body = ResolveInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "BAD_REQUEST", issues: body.error.issues }, 400);
    try {
      return c.json({ chips: await resolveTaste(body.data.text, deps) });
    } catch (error) {
      const { status, ...publicError } = toPublicError(error);
      return c.json(publicError, status);
    }
  });

  app.post("/api/transplant", async (c) => {
    if (!deps.limits.transplant.allow(clientIp(c))) return c.json({ code: "RATE_LIMITED" }, 429);
    const body = TransplantInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "BAD_REQUEST", issues: body.error.issues }, 400);
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const emit = (event: TransplantEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
      };
      try {
        await runTransplant(body.data, deps, emit);
      } catch (error) {
        const { status: _status, ...publicError } = toPublicError(error);
        emit({ type: "error", ...publicError });
      }
      await chain;
    });
  });

  return app;
}
```

`server/src/main.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { loadHoods } from "./hoods-data.ts";
import { createLlm } from "./llm/llm.ts";
import { geminiProvider, groqProvider } from "./llm/providers.ts";
import { withCache } from "./qloo/cache.ts";
import { createQlooClient } from "./qloo/client.ts";
import { type QuotaState, withQuotaGuard } from "./qloo/quota.ts";
import { createRateLimiter } from "./rate-limit.ts";

const HOUR_MS = 60 * 60 * 1000;
const config = loadConfig();
mkdirSync(dirname(config.CACHE_PATH), { recursive: true });

const quota: QuotaState = { remaining: undefined };
const qloo = withCache(
  withQuotaGuard(createQlooClient({ apiKey: config.QLOO_API_KEY, baseUrl: config.QLOO_BASE_URL }), config.QUOTA_FLOOR, quota),
  config.CACHE_PATH,
);
const llm = createLlm([
  geminiProvider({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }),
  ...(config.GROQ_API_KEY ? [groqProvider({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL })] : []),
]);

const app = createApp({
  qloo,
  llm,
  quota,
  hoodsFor: loadHoods,
  limits: { resolve: createRateLimiter(30, HOUR_MS), transplant: createRateLimiter(6, HOUR_MS) },
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`Transplant API listening on http://localhost:${info.port}`));
```

**Step 4: Run** `npx vitest run && npm run typecheck` → all PASS. If `@hono/node-server` 2.x changed the `serve` signature, follow its README, keeping the same behavior.

**Step 5: Commit** `git add server/src/rate-limit.ts server/src/app* server/src/main.ts && git commit -m "Add Hono API with SSE transplant stream and per-IP limits"`

---

### Task 12: Live smoke test (spends ~7 Qloo calls, 2 LLM calls)

**Step 1:** Start the server in the background: `npm run dev` → `Transplant API listening on http://localhost:8787`.

**Step 2:** Resolve:

```bash
curl -s localhost:8787/api/resolve -H 'content-type: application/json' \
  -d '{"text":"I love Khruangbin, Fleabag, natural wine bars and Aesop"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const c of JSON.parse(s).chips)console.log(c.status, c.kind, c.query,'->',c.selected?.name, c.selected?.id)})"
```

Expected: 4 lines, Aesop → brand, natural wine bars → a `urn:tag:` id, all `resolved`.

**Step 3:** Transplant with those ids (substitute the printed entity ids and tag id):

```bash
curl -sN localhost:8787/api/transplant -H 'content-type: application/json' \
  -d '{"cityId":"nyc","mode":"moving","people":[{"label":"You","names":["Khruangbin","Fleabag","Aesop","natural wine bars"],"entities":["<id1>","<id2>","<id3>"],"tags":["<tag>"]}]}'
```

Expected: `event: step` lines, then `hoods` (Brooklyn hoods near the top), `places`, `story` with `"source":"llm"`, `done`.

**Step 4:** `curl -s localhost:8787/api/health` shows `qlooMonthRemaining` ≈ 9900. Rerun Step 3; it should be instant (cache) and the remaining count unchanged. Stop the server.

**Step 5:** Record the outputs (hood names, place names, story excerpt) in the design doc's M1/M2 results section and commit.

---

### Task 13: Expand to 12 curated cities (spends ~24 Qloo calls)

**Files:** Modify `server/src/cities.ts`, `scripts/fetch-hoods.ts`, `scripts/record-fixtures.ts`.

**Step 1:** In `scripts/fetch-hoods.ts`, prefer English names for non-Latin scripts. Replace `name: el.tags.name!` with:

```ts
name: /[^\u0000-\u024F\s'’.,()-]/.test(el.tags.name!) ? (el.tags["name:en"] ?? el.tags.name!) : el.tags.name!,
```

**Step 2:** Append to `CITIES` (initial `hoodKinds` are a starting guess, tuned in Step 5):

```ts
  { id: "la", name: "Los Angeles", query: "Los Angeles", bbox: [33.7, -118.67, 34.34, -118.15], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "paris", name: "Paris", query: "Paris", bbox: [48.815, 2.224, 48.902, 2.47], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "berlin", name: "Berlin", query: "Berlin", bbox: [52.338, 13.088, 52.675, 13.761], hoodKinds: ["suburb", "quarter"] },
  { id: "tokyo", name: "Tokyo", query: "Tokyo", bbox: [35.53, 139.56, 35.82, 139.92], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "seoul", name: "Seoul", query: "Seoul", bbox: [37.42, 126.76, 37.7, 127.18], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "cdmx", name: "Mexico City", query: "Mexico City", bbox: [19.2, -99.33, 19.59, -98.94], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "austin", name: "Austin", query: "Austin", bbox: [30.1, -97.94, 30.52, -97.56], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "toronto", name: "Toronto", query: "Toronto", bbox: [43.58, -79.64, 43.86, -79.11], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
  { id: "barcelona", name: "Barcelona", query: "Barcelona", bbox: [41.32, 2.05, 41.47, 2.23], hoodKinds: ["suburb", "quarter", "neighbourhood"] },
```

**Step 3:** Make `scripts/record-fixtures.ts` resumable and cache-backed: wrap the client with `withCache(..., ".cache/qloo.sqlite")` (create `.cache` first) and skip any `heatmap-${profile}-${city.id}.json` that already exists.

**Step 4:** Run `npm run hoods` (rerun on Overpass 504s; it resumes), then `npm run record`. Expected: 9 new hood files, 18 new heatmap fixtures, quota ≈ 9,870.

**Step 5:** For each new city print kind counts (`node -e` as in M1), run `npm run lift-report`, and tune `hoodKinds`/`adminLevels` per city until top hoods have ≥4 cells and recognizable names. A city that cannot reach a plausible result is marked `beta: true` in `cities.ts` (add the optional field) and surfaced as such in the UI.

**Step 6:** Record the 12-city table in the design doc and commit:

```bash
git add server scripts docs
git commit -m "Expand Transplant to 12 curated cities with tuned neighborhood kinds"
```

---

## Out of scope for M2 (tracked)

- Agent tool loop for refinement chat ("quieter", "more nightlife") → M4.
- Beta "any city" with on-demand Overpass + geocoding → M4.
- Places for hoods #2 and #3 on demand (`GET /api/places`) → M3, when the UI needs it.
- Demo profiles warmed into the cache → M4.
