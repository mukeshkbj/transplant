# Transplant M4 — Guide Agent, Demos, Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans (or subagent-driven-development) to implement task-by-task.

**Goal:** Make Transplant visibly agentic and judge-proof: a "local guide" agent that refines results through real Qloo tool calls ("quieter", "more nightlife"), one-click demo profiles that work even when quota is low, shareable result links, and a quota banner — all verified in a real browser.

**Architecture:** A provider-neutral tool-calling layer (Gemini function calling with thought-signature round-trip; Groq OpenAI-style tool calls) drives a bounded agent loop (≤5 steps, provider fallback). The refine service exposes three tools — `find_tags` (Qloo `/v2/tags`, place parents), `find_places` (Qloo place insights around an allowed hood with `filter.tags` / `filter.exclude.tags`), `focus_hood` — and returns a reply, UI actions, and a visible tool trace. Demo profiles are pre-resolved Qloo picks stored in `server/data/demos.json`; the server warms their Qloo responses into the SQLite cache at startup. Share links encode compact picks in the URL.

**Tech Stack:** Existing stack only (Hono, zod, React, Vitest). No new dependencies.

**Verified on 2026-10-07 (3 Qloo calls):** `/v2/tags?filter.query=quiet&filter.parents.types=urn:entity:place` → `urn:tag:ambience:qloo:quiet`, `urn:tag:noise_level:qloo:quiet`, `urn:tag:good_for:qloo:quiet_dining`, …; `nightlife` → `urn:tag:good_for:qloo:nightlife`, `urn:tag:genre:place:nightlife`, …. Place insights around Greenpoint with `filter.tags=urn:tag:ambience:qloo:quiet` drop the music venues and return Desert Island, Land to Sea, Tea Bar, Patisserie Tomoko, Film Noir Cinema.

**Ground rules:** No secrets client-side or in logs. Unit tests make zero network calls (fake Qloo, fake tool providers, fake fetch). The agent may only use hood IDs the client already holds and tag IDs that `find_tags` returned. Run from `D:\Qloo`; after each task `npx vitest run && npm run typecheck`.

---

### Task 0: Real-browser QA of M3 (deferred Task 10)

1. Ensure `npm run dev` (API :8787) and `npm run web` (Vite :5173) are running.
2. With the `agent-browser` MCP (session `qa`, viewport 1440×900): open `http://localhost:5173`, snapshot, pick NYC, click the "e.g. Khruangbin…" example, Read my taste, wait for stamps, click Transplant. Wait for the visa; screenshot. Check console errors (`agent_browser_eval` with a `window.onerror` collector installed before navigation, or read the Vite/API logs).
3. Click hood #2; confirm `/api/places` returns and the spots list updates. Toggle blend with the Metallica example for person 2; confirm meters and shared tags.
4. Repeat at 390×844 (map above column).
5. Fix every defect found. For logic defects write a failing test first. Commit fixes: `git commit -m "Fix issues found in M3 browser QA"`.

Record results under "M3 browser QA" in the design doc.

---

### Task 1: Place filters and tag scoping (server)

**Files:** Modify `server/src/qloo/api.ts`, `server/src/qloo/api.test.ts`, `server/src/transplant.ts` (export `union`).

**Step 1: Failing tests** — append to `server/src/qloo/api.test.ts` inside the `describe`:

```ts
  it("placesNear passes include/exclude tag filters", async () => {
    const { client, calls } = fakeQloo(() => fixture("places-indie-greenpoint.json"));

    await placesNear(client, { entities: ["E1"], tags: [] }, { lat: 40.73, lng: -73.95 }, { includeTags: ["urn:tag:ambience:qloo:quiet"], excludeTags: ["urn:tag:good_for:qloo:nightlife"], take: 12 });

    expect(calls[0]!.params).toMatchObject({
      "filter.tags": ["urn:tag:ambience:qloo:quiet"],
      "filter.exclude.tags": ["urn:tag:good_for:qloo:nightlife"],
      take: 12,
    });
  });

  it("searchTags can scope tags to a parent entity type", async () => {
    const { client, calls } = fakeQloo(() => fixture("tags-natural-wine-bars.json"));

    await searchTags(client, "quiet", { take: 6, parentType: "urn:entity:place" });

    expect(calls[0]!.params).toEqual({ "filter.query": "quiet", take: 6, "filter.parents.types": "urn:entity:place" });
  });
```

**Step 2: Run** `npx vitest run server/src/qloo/api.test.ts` → FAIL.

**Step 3: Implement** in `server/src/qloo/api.ts`:

```ts
export interface TagSearchOptions {
  take?: number;
  parentType?: string;
}

export async function searchTags(qloo: QlooClient, query: string, { take = 3, parentType }: TagSearchOptions = {}): Promise<TagCandidate[]> {
  const { data } = await qloo.get<{ results?: { tags?: TagCandidate[] } }>("/v2/tags", {
    "filter.query": query,
    take,
    ...(parentType ? { "filter.parents.types": parentType } : {}),
  });
  return (data.results?.tags ?? []).map(({ id, name, type }) => ({ id, name, type }));
}

export interface PlaceQuery {
  radiusM?: number;
  take?: number;
  includeTags?: string[];
  excludeTags?: string[];
}

export async function placesNear(
  qloo: QlooClient,
  signals: Signals,
  at: { lat: number; lng: number },
  { radiusM = 1200, take = 30, includeTags = [], excludeTags = [] }: PlaceQuery = {},
): Promise<Place[]> {
  const { data } = await qloo.get<{ results?: { entities?: RawPlace[] } }>("/v2/insights", {
    "filter.type": "urn:entity:place",
    ...signalParams(signals),
    "filter.location": `POINT(${at.lng} ${at.lat})`,
    "filter.location.radius": radiusM,
    ...(includeTags.length > 0 ? { "filter.tags": includeTags } : {}),
    ...(excludeTags.length > 0 ? { "filter.exclude.tags": excludeTags } : {}),
    take,
  });
  // …existing mapping unchanged…
}
```

In `server/src/transplant.ts` change `const union = …` to `export const union = …`.

**Step 4: Run** → full suite PASS; typecheck clean (existing callers use defaults).

**Step 5: Commit** `git commit -am "Support Qloo tag filters for places and parent-scoped tag search"`

---

### Task 2: Provider-neutral tool calling

**Files:** Create `server/src/llm/tools.ts`, `server/src/llm/tools.test.ts`, `scripts/smoke-tools.ts`; Modify `server/src/llm/providers.ts` (export `failure`).

**Step 1: Failing test** `server/src/llm/tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { type ChatMessage, geminiTools, groqTools, type ToolSpec } from "./tools.ts";

const tools: ToolSpec[] = [{ name: "find_tags", description: "d", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
const ok = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
const sent = (f: ReturnType<typeof ok>) => JSON.parse(String(f.mock.calls[0]![1]?.body));

const history: ChatMessage[] = [
  { role: "user", text: "quieter please" },
  {
    role: "assistant",
    text: "",
    calls: [
      { id: "c1", name: "find_tags", args: { query: "quiet" }, signature: "sig-1" },
      { id: "c2", name: "find_tags", args: { query: "calm" } },
    ],
  },
  { role: "tool", call: { id: "c1", name: "find_tags", args: { query: "quiet" } }, result: [{ id: "urn:tag:a", name: "Quiet" }] },
  { role: "tool", call: { id: "c2", name: "find_tags", args: { query: "calm" } }, result: [] },
];

describe("geminiTools", () => {
  it("maps history to Gemini contents, echoes thought signatures, and groups function responses", async () => {
    const fetchImpl = ok({ candidates: [{ content: { parts: [{ text: "Done." }] } }] });

    const turn = await geminiTools({ apiKey: "k", model: "m", fetchImpl }).turn({ system: "sys", messages: history, tools });

    const body = sent(fetchImpl);
    expect(body.tools).toEqual([{ functionDeclarations: tools }]);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[1].parts[0]).toEqual({ functionCall: { name: "find_tags", args: { query: "quiet" } }, thoughtSignature: "sig-1" });
    expect(body.contents[2].parts).toHaveLength(2);
    expect(body.contents[2].parts[0]).toEqual({ functionResponse: { name: "find_tags", response: { result: [{ id: "urn:tag:a", name: "Quiet" }] } } });
    expect(turn).toEqual({ text: "Done.", calls: [] });
  });

  it("parses function calls with their signatures and ignores thought text", async () => {
    const fetchImpl = ok({
      candidates: [
        {
          content: {
            parts: [{ text: "thinking", thought: true }, { functionCall: { name: "find_tags", args: { query: "quiet" } }, thoughtSignature: "sig-9" }],
          },
        },
      ],
    });

    const turn = await geminiTools({ apiKey: "k", model: "m", fetchImpl }).turn({ system: "s", messages: [{ role: "user", text: "x" }], tools });

    expect(turn).toEqual({ text: "", calls: [{ id: "call-1", name: "find_tags", args: { query: "quiet" }, signature: "sig-9" }] });
  });
});

describe("groqTools", () => {
  it("maps history to OpenAI-style messages and parses tool calls", async () => {
    const fetchImpl = ok({
      choices: [{ message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "find_tags", arguments: '{"query":"loud"}' } }] } }],
    });

    const turn = await groqTools({ apiKey: "k", model: "gm", fetchImpl }).turn({ system: "sys", messages: history, tools });

    const body = sent(fetchImpl);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(body.messages[2].tool_calls[0]).toEqual({ id: "c1", type: "function", function: { name: "find_tags", arguments: '{"query":"quiet"}' } });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '[{"id":"urn:tag:a","name":"Quiet"}]' });
    expect(body.tools).toEqual([{ type: "function", function: tools[0] }]);
    expect(turn).toEqual({ text: "", calls: [{ id: "t1", name: "find_tags", args: { query: "loud" } }] });
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement.** In `server/src/llm/providers.ts` change `const failure` to `export const failure`. Create `server/src/llm/tools.ts`:

```ts
import { failure } from "./providers.ts";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Gemini 3 thought signature; must be echoed back with the call. */
  signature?: string;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: ToolCall[] }
  | { role: "tool"; call: ToolCall; result: unknown };

export interface ToolTurnRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ToolTurn {
  text: string;
  calls: ToolCall[];
}

export interface ToolProvider {
  name: string;
  turn(request: ToolTurnRequest): Promise<ToolTurn>;
}

interface ProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 25_000;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

type GeminiContent = { role: "user" | "model"; parts: unknown[] };

const geminiContent = (m: ChatMessage): GeminiContent => {
  if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
  if (m.role === "assistant")
    return {
      role: "model",
      parts: [
        ...(m.text ? [{ text: m.text }] : []),
        ...m.calls.map((c) => ({ functionCall: { name: c.name, args: c.args }, ...(c.signature ? { thoughtSignature: c.signature } : {}) })),
      ],
    };
  return { role: "user", parts: [{ functionResponse: { name: m.call.name, response: { result: m.result } } }] };
};

const mergeRoles = (contents: GeminiContent[]) =>
  contents.reduce<GeminiContent[]>((out, c) => {
    const last = out.at(-1);
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else out.push({ role: c.role, parts: [...c.parts] });
    return out;
  }, []);

export function geminiTools({ apiKey, model, fetchImpl = fetch }: ProviderOptions): ToolProvider {
  return {
    name: `gemini:${model}`,
    async turn({ system, messages, tools }) {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: mergeRoles(messages.map(geminiContent)),
          tools: [{ functionDeclarations: tools }],
          generationConfig: { temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { candidates?: { content?: { parts?: GeminiPart[] } }[] };
      const parts = body.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts
          .filter((p) => !p.thought)
          .map((p) => p.text ?? "")
          .join("")
          .trim(),
        calls: parts.flatMap((p, i) =>
          p.functionCall
            ? [{ id: `call-${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {}, ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}) }]
            : [],
        ),
      };
    },
  };
}

const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const groqMessage = (m: ChatMessage) => {
  if (m.role === "user") return { role: "user", content: m.text };
  if (m.role === "assistant")
    return {
      role: "assistant",
      content: m.text || null,
      ...(m.calls.length > 0
        ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : {}),
    };
  return { role: "tool", tool_call_id: m.call.id, content: JSON.stringify(m.result) };
};

export function groqTools({ apiKey, model, fetchImpl = fetch }: ProviderOptions): ToolProvider {
  return {
    name: `groq:${model}`,
    async turn({ system, messages, tools }) {
      const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          messages: [{ role: "system", content: system }, ...messages.map(groqMessage)],
          tools: tools.map((t) => ({ type: "function", function: t })),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      const msg = body.choices?.[0]?.message;
      return {
        text: (msg?.content ?? "").trim(),
        calls: (msg?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
      };
    },
  };
}
```

**Step 4: Run** → PASS (3); typecheck clean.

**Step 5: Live smoke (2–4 LLM calls, 0 Qloo)** — `scripts/smoke-tools.ts`:

```ts
import { loadConfig } from "../server/src/config.ts";
import { type ChatMessage, geminiTools, groqTools, type ToolProvider, type ToolSpec } from "../server/src/llm/tools.ts";

const config = loadConfig();
const tools: ToolSpec[] = [
  { name: "find_tags", description: "Find Qloo tag ids for a quality.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const providers: ToolProvider[] = [
  geminiTools({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }),
  ...(config.GROQ_API_KEY ? [groqTools({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL })] : []),
];

for (const p of providers) {
  const messages: ChatMessage[] = [{ role: "user", text: "Find the tag for quiet places, then tell me its id." }];
  const first = await p.turn({ system: "Use tools before answering.", messages, tools });
  console.log(p.name, "calls:", JSON.stringify(first.calls.map((c) => ({ name: c.name, args: c.args, signed: Boolean(c.signature) }))));
  messages.push({ role: "assistant", text: first.text, calls: first.calls });
  for (const call of first.calls) messages.push({ role: "tool", call, result: [{ id: "urn:tag:ambience:qloo:quiet", name: "Quiet" }] });
  const second = await p.turn({ system: "Use tools before answering.", messages, tools });
  console.log(p.name, "final:", second.text.slice(0, 160), "| more calls:", second.calls.length);
}
```

Add script `"smoke-tools": "node --env-file=.env --import tsx scripts/smoke-tools.ts"` and run `npm run smoke-tools`. Expected: each provider makes a `find_tags` call, then answers with the tag id (Gemini line shows `signed: true` if the model emits signatures). If Gemini rejects the second turn, fix the request mapping before continuing.

**Step 6: Commit** `git add server/src/llm scripts/smoke-tools.ts package.json && git commit -m "Add provider-neutral tool calling for Gemini and Groq"`

---

### Task 3: Bounded agent loop with provider fallback

**Files:** Create `server/src/agent.ts`, `server/src/agent.test.ts`; Modify `server/test/fakes.ts`.

**Step 1: Failing test.** Append to `server/test/fakes.ts`:

```ts
import type { ToolProvider, ToolTurn, ToolTurnRequest } from "../src/llm/tools.ts";

export function fakeToolProvider(name: string, script: ToolTurn[] | ((req: ToolTurnRequest, step: number) => ToolTurn)) {
  const requests: ToolTurnRequest[] = [];
  const provider: ToolProvider = {
    name,
    async turn(req) {
      requests.push(structuredClone(req));
      const step = requests.length - 1;
      const next = typeof script === "function" ? script(req, step) : script[step];
      if (!next) throw new Error(`${name}: no scripted turn ${step}`);
      return next;
    },
  };
  return { provider, requests };
}
```

(Move the new import to the top of the file.)

`server/src/agent.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fakeToolProvider } from "../test/fakes.ts";
import { type AgentTool, runAgent } from "./agent.ts";
import { LlmError } from "./llm/llm.ts";

const echo: AgentTool = {
  spec: { name: "echo", description: "d", parameters: { type: "object", properties: {} } },
  run: vi.fn(async (args) => ({ result: { got: args }, summary: `echoed ${JSON.stringify(args)}` })),
};

describe("runAgent", () => {
  it("executes tool calls, feeds results back, and returns the final reply with a trace", async () => {
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "echo", args: { q: "quiet" } }] },
      { text: "Here you go.", calls: [] },
    ]);

    const out = await runAgent({ providers: [provider], system: "s", prompt: "hi", tools: [echo] });

    expect(out).toEqual({ reply: "Here you go.", trace: [{ tool: "echo", summary: 'echoed {"q":"quiet"}' }], provider: "p" });
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", result: { got: { q: "quiet" } } });
  });

  it("reports unknown tools and tool errors back to the model instead of crashing", async () => {
    const failing: AgentTool = { spec: { ...echo.spec, name: "boom" }, run: async () => Promise.reject(new Error("bad hood")) };
    const { provider, requests } = fakeToolProvider("p", [
      {
        text: "",
        calls: [
          { id: "1", name: "nope", args: {} },
          { id: "2", name: "boom", args: {} },
        ],
      },
      { text: "Sorry.", calls: [] },
    ]);

    const out = await runAgent({ providers: [provider], system: "s", prompt: "hi", tools: [failing] });

    expect(out.trace.map((t) => t.summary)).toEqual(["unknown tool nope", "boom failed: bad hood"]);
    expect(requests[1]!.messages.slice(-2).map((m) => (m.role === "tool" ? m.result : null))).toEqual([{ error: "Unknown tool nope" }, { error: "bad hood" }]);
  });

  it("falls back to the next provider and restarts the conversation", async () => {
    const down = fakeToolProvider("down", () => {
      throw new Error("HTTP 503");
    });
    const up = fakeToolProvider("up", [{ text: "Fine.", calls: [] }]);

    const out = await runAgent({ providers: [down.provider, up.provider], system: "s", prompt: "hi", tools: [echo], log: () => {} });

    expect(out).toMatchObject({ reply: "Fine.", provider: "up", trace: [] });
  });

  it("gives up after maxSteps tool rounds", async () => {
    const loop = fakeToolProvider("loop", () => ({ text: "", calls: [{ id: "x", name: "echo", args: {} }] }));

    await expect(runAgent({ providers: [loop.provider], system: "s", prompt: "hi", tools: [echo], maxSteps: 2, log: () => {} })).rejects.toBeInstanceOf(LlmError);
    expect(loop.requests).toHaveLength(2);
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement** `server/src/agent.ts`:

```ts
import { LlmError } from "./llm/llm.ts";
import type { ChatMessage, ToolProvider, ToolSpec } from "./llm/tools.ts";

export interface AgentTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<{ result: unknown; summary: string }>;
}

export interface TraceStep {
  tool: string;
  summary: string;
}

export interface AgentResult {
  reply: string;
  trace: TraceStep[];
  provider: string;
}

interface AgentOptions {
  providers: ToolProvider[];
  system: string;
  prompt: string;
  tools: AgentTool[];
  maxSteps?: number;
  log?: (message: string) => void;
}

export async function runAgent({ providers, system, prompt, tools, maxSteps = 5, log = console.warn }: AgentOptions): Promise<AgentResult> {
  const specs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const failures: string[] = [];

  for (const provider of providers) {
    const messages: ChatMessage[] = [{ role: "user", text: prompt }];
    const trace: TraceStep[] = [];
    try {
      for (let step = 0; step < maxSteps; step++) {
        const turn = await provider.turn({ system, messages, tools: specs });
        if (turn.calls.length === 0) return { reply: turn.text, trace, provider: provider.name };
        messages.push({ role: "assistant", text: turn.text, calls: turn.calls });
        for (const call of turn.calls) {
          const tool = byName.get(call.name);
          const { result, summary } = tool
            ? await tool.run(call.args).catch((error: unknown) => ({
                result: { error: (error as Error).message },
                summary: `${call.name} failed: ${(error as Error).message}`,
              }))
            : { result: { error: `Unknown tool ${call.name}` }, summary: `unknown tool ${call.name}` };
          trace.push({ tool: call.name, summary });
          messages.push({ role: "tool", call, result });
        }
      }
      throw new Error(`no answer within ${maxSteps} steps`);
    } catch (error) {
      failures.push(`${provider.name}: ${(error as Error).message}`);
      log(`Agent fallback (${failures.at(-1)})`);
    }
  }
  throw new LlmError(`Agent failed: ${failures.join("; ")}`);
}
```

**Step 4: Run** → PASS (4).

**Step 5: Commit** `git add server/src/agent* server/test/fakes.ts && git commit -m "Add bounded tool-using agent loop with provider fallback"`

---

### Task 4: Refine service and `POST /api/refine`

**Files:** Create `server/src/refine.ts`, `server/src/refine.test.ts`; Modify `server/src/app.ts`, `server/src/app.test.ts`, `server/src/main.ts`.

**Step 1: Failing tests** `server/src/refine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fakeQloo, fakeToolProvider, fixture } from "../test/fakes.ts";
import { CITIES } from "./cities.ts";
import { loadHoods } from "./hoods-data.ts";
import { refine } from "./refine.ts";

const nyc = CITIES.find((c) => c.id === "nyc")!;
const greenpoint = loadHoods(nyc).find((h) => h.name === "Greenpoint")!;
const williamsburg = loadHoods(nyc).find((h) => h.name === "Williamsburg")!;
const input = {
  cityId: "nyc",
  people: [{ label: "You", names: ["Khruangbin", "Fleabag", "Aesop"], entities: ["a", "b", "c"], tags: [] }],
  hoods: [
    { id: greenpoint.id, name: "Greenpoint" },
    { id: williamsburg.id, name: "Williamsburg" },
  ],
  activeHoodId: greenpoint.id,
  message: "somewhere quieter",
};

const qloo = () =>
  fakeQloo((path) => {
    if (path === "/v2/tags") return { results: { tags: [{ id: "urn:tag:ambience:qloo:quiet", name: "Quiet", type: "urn:tag:ambience:qloo" }] } };
    if (path === "/v2/insights") return fixture("places-indie-greenpoint.json");
    return undefined;
  });

describe("refine", () => {
  it("lets the agent find tags, filter places in an allowed hood, and returns actions plus a trace", async () => {
    const q = qloo();
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "find_tags", args: { query: "quiet" } }] },
      { text: "", calls: [{ id: "2", name: "find_places", args: { hood_id: greenpoint.id, include_tags: ["urn:tag:ambience:qloo:quiet"], exclude_tags: [] } }] },
      { text: "Try Desert Island and Tea Bar.", calls: [] },
    ]);

    const out = await refine(input, { qloo: q.client, providers: [provider], hoodsFor: loadHoods });

    expect(out.reply).toBe("Try Desert Island and Tea Bar.");
    expect(out.trace.map((t) => t.tool)).toEqual(["find_tags", "find_places"]);
    expect(out.actions).toEqual([{ type: "places", hoodId: greenpoint.id, filters: ["Quiet"], places: expect.any(Array) }]);
    expect(q.calls.find((c) => c.path === "/v2/tags")!.params).toMatchObject({ "filter.parents.types": "urn:entity:place" });
    expect(q.calls.find((c) => c.path === "/v2/insights")!.params).toMatchObject({ "filter.tags": ["urn:tag:ambience:qloo:quiet"] });
    expect(JSON.parse(requests[0]!.messages[0]!.role === "user" ? requests[0]!.messages[0]!.text.split("\n\nUser: ")[0]! : "{}")).toMatchObject({
      activeHoodId: greenpoint.id,
    });
  });

  it("rejects hoods the user wasn't shown and tag ids that find_tags never returned", async () => {
    const q = qloo();
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "find_places", args: { hood_id: "osm:elsewhere", include_tags: [], exclude_tags: [] } }] },
      { text: "", calls: [{ id: "2", name: "find_places", args: { hood_id: greenpoint.id, include_tags: ["urn:tag:made:up"], exclude_tags: [] } }] },
      { text: "Okay.", calls: [] },
    ]);

    const out = await refine(input, { qloo: q.client, providers: [provider], hoodsFor: loadHoods });

    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", result: { error: expect.stringMatching(/not one of the user's neighborhoods/) } });
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", result: { error: expect.stringMatching(/call find_tags first/) } });
    expect(out.actions).toEqual([]);
    expect(q.calls).toHaveLength(0);
  });

  it("focus_hood switches the active neighborhood", async () => {
    const { provider } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "focus_hood", args: { hood_id: williamsburg.id } }] },
      { text: "Switched to Williamsburg.", calls: [] },
    ]);

    const out = await refine(input, { qloo: qloo().client, providers: [provider], hoodsFor: loadHoods });

    expect(out.actions).toEqual([{ type: "focus", hoodId: williamsburg.id }]);
  });
});
```

In `server/src/app.test.ts`: add `tools: [fakeToolProvider("p", [{ text: "Hello.", calls: [] }]).provider]`, `quotaFloor: 1500`, and `refine: createRateLimiter(limit, 60_000)` to `deps()`/`limits`; import `fakeToolProvider`; change the health expectation to `{ ok: true, qlooMonthRemaining: 9000, quotaFloor: 1500 }`; and add:

```ts
  it("refines with the guide agent", async () => {
    const greenpoint = loadHoods(CITIES.find((c) => c.id === "nyc")!).find((h) => h.name === "Greenpoint")!;
    const body = { cityId: "nyc", people: transplantBody.people, hoods: [{ id: greenpoint.id, name: "Greenpoint" }], activeHoodId: greenpoint.id, message: "quieter" };

    const res = await createApp(deps()).request("/api/refine", post(body));

    expect(await res.json()).toEqual({ reply: "Hello.", actions: [], trace: [] });
    expect((await createApp(deps()).request("/api/refine", post({ ...body, message: "" }))).status).toBe(400);
  });
```

**Step 2: Run** → FAIL.

**Step 3: Implement** `server/src/refine.ts`:

```ts
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
- Only use hoodIds from the JSON. Call focus_hood when they want to switch neighborhood.
- Reply in at most 60 words of plain text, naming 2-3 places that find_places returned. Never invent places or facts. If nothing fits, say so and suggest another phrasing.`;

const stringArray = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export async function refine(input: RefineInput, deps: RefineDeps): Promise<RefineResult> {
  const city = CITIES.find((c) => c.id === input.cityId);
  if (!city) return { reply: `Transplant doesn't cover that city yet.`, actions: [], trace: [] };
  const shownIds = new Set(input.hoods.map((h) => h.id));
  const hoods = new Map(deps.hoodsFor(city).filter((h) => shownIds.has(h.id)).map((h) => [h.id, h]));
  const knownTags = new Map<string, string>();
  const actions = new Map<string, RefineAction>();

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
        parameters: { type: "object", properties: { query: { type: "string", description: "Short phrase, e.g. 'quiet' or 'live music'" } }, required: ["query"] },
      },
      async run(args) {
        const query = String(args.query ?? "").slice(0, 60);
        const tags = await searchTags(deps.qloo, query, { take: 6, parentType: "urn:entity:place" });
        for (const t of tags) knownTags.set(t.id, t.name);
        return { result: tags.map(({ id, name }) => ({ id, name })), summary: `Qloo tags for "${query}": ${tags.map((t) => t.name).join(", ") || "none"}` };
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
          required: ["hood_id", "include_tags", "exclude_tags"],
        },
      },
      async run(args) {
        const hood = hoodFor(args.hood_id);
        const includeTags = tagsFrom(args.include_tags);
        const excludeTags = tagsFrom(args.exclude_tags);
        const places = curatePlaces(await placesNear(deps.qloo, union(input.people), hood, { includeTags, excludeTags }), 6);
        const filters = [...includeTags.map((id) => knownTags.get(id)!), ...excludeTags.map((id) => `not ${knownTags.get(id)!}`)];
        actions.set(`places:${hood.id}`, { type: "places", hoodId: hood.id, filters, places });
        return {
          result: places.map((p) => ({ placeId: p.id, name: p.name, label: placeLabel(p) })),
          summary: `${places.length} places in ${hood.name}${filters.length > 0 ? ` · ${filters.join(", ")}` : ""}`,
        };
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
  const { reply, trace } = await runAgent({ providers: deps.providers, system: SYSTEM, prompt: `${JSON.stringify(context)}\n\nUser: ${input.message}`, tools });
  return { reply, actions: [...actions.values()], trace };
}
```

In `server/src/app.ts`:
- `AppDeps` gains `tools: ToolProvider[]; quotaFloor: number;` and `limits.refine: RateLimiter`.
- Health: `c.json({ ok: true, qlooMonthRemaining: deps.quota.remaining ?? null, quotaFloor: deps.quotaFloor })`.
- Add:

```ts
  app.post("/api/refine", async (c) => {
    if (!deps.limits.refine.allow(clientIp(c))) return c.json({ code: "RATE_LIMITED" }, 429);
    const body = RefineInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "BAD_REQUEST", issues: body.error.issues }, 400);
    try {
      return c.json(await refine(body.data, { qloo: deps.qloo, providers: deps.tools, hoodsFor: deps.hoodsFor }));
    } catch (error) {
      const { status, ...publicError } = toPublicError(error);
      return c.json(publicError, status);
    }
  });
```

In `server/src/main.ts`: build `const tools = [geminiTools({...}), ...(GROQ ? [groqTools({...})] : [])]`, pass `tools`, `quotaFloor: config.QUOTA_FLOOR`, and `refine: createRateLimiter(20, HOUR_MS)`.

**Step 4: Run** → PASS; typecheck clean.

**Step 5: Commit** `git add server && git commit -m "Add Qloo-grounded guide agent and /api/refine"`

---

### Task 5: Demo profiles and cache warm-up (server)

**Files:** Create `scripts/build-demos.ts`, `server/data/demos.json` (generated), `server/src/demos.ts`, `server/src/demos.test.ts`; Modify `server/src/app.ts`, `server/src/app.test.ts`, `server/src/main.ts`, `package.json`.

**Step 1: Build script** `scripts/build-demos.ts` (≈12 Qloo calls on first run, cached afterwards):

```ts
import { mkdir, writeFile } from "node:fs/promises";
import type { Demo } from "../server/src/demos.ts";
import { type EntityType, searchEntities, searchTags } from "../server/src/qloo/api.ts";
import { withCache } from "../server/src/qloo/cache.ts";
import { createQlooClient } from "../server/src/qloo/client.ts";
import type { ChipOption } from "../server/src/resolve.ts";

type Pick = [query: string, type: EntityType | "concept"];
const SPECS: { id: string; title: string; blurb: string; cityId: string; mode: "moving" | "visiting"; people: { label: string; picks: Pick[] }[] }[] = [
  {
    id: "nyc-indie",
    title: "Indie, moving to New York",
    blurb: "Khruangbin, Fleabag, Aesop, natural wine",
    cityId: "nyc",
    mode: "moving",
    people: [{ label: "You", picks: [["Khruangbin", "artist"], ["Fleabag", "tv_show"], ["Aesop", "brand"], ["natural wine bars", "concept"]] }],
  },
  {
    id: "london-blend",
    title: "Two tastes, one London flat",
    blurb: "Phoebe Bridgers + Severance meets Metallica + Top Gun",
    cityId: "london",
    mode: "moving",
    people: [
      { label: "You", picks: [["Phoebe Bridgers", "artist"], ["Severance", "tv_show"], ["vintage clothing", "concept"]] },
      { label: "Them", picks: [["Metallica", "artist"], ["Top Gun: Maverick", "movie"], ["Harley-Davidson", "brand"]] },
    ],
  },
  {
    id: "la-visit",
    title: "A long weekend in LA",
    blurb: "Kendrick Lamar, The Bear, Patagonia, tacos",
    cityId: "la",
    mode: "visiting",
    people: [{ label: "You", picks: [["Kendrick Lamar", "artist"], ["The Bear", "tv_show"], ["Patagonia", "brand"], ["tacos", "concept"]] }],
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
  const people = [];
  for (const person of spec.people) {
    const picks: ChipOption[] = [];
    for (const pick of person.picks) picks.push(await resolvePick(pick));
    people.push({ label: person.label, picks });
  }
  demos.push({ ...spec, people });
  console.log(spec.id, people.map((p) => `${p.label}: ${p.picks.map((o) => `${o.name} (${o.type})`).join(", ")}`).join(" | "));
}
await writeFile("server/data/demos.json", `${JSON.stringify(demos, null, 2)}\n`);
```

Add script `"demos": "node --env-file=.env --import tsx scripts/build-demos.ts"`; run `npm run demos`; check every pick is the intended entity (e.g. Aesop → brand, The Bear → tv_show). Fix specs and rerun if not.

**Step 2: Failing tests** `server/src/demos.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { demoInput, loadDemos, warmDemos } from "./demos.ts";

describe("demos", () => {
  it("loads three resolved demo profiles", () => {
    const demos = loadDemos();

    expect(demos.map((d) => d.id)).toEqual(["nyc-indie", "london-blend", "la-visit"]);
    expect(demos.every((d) => d.people.every((p) => p.picks.length >= 3 && p.picks.every((o) => o.id)))).toBe(true);
  });

  it("turns a demo into transplant input", () => {
    const input = demoInput(loadDemos().find((d) => d.id === "nyc-indie")!);

    expect(input).toMatchObject({ cityId: "nyc", mode: "moving" });
    expect(input.people[0]!.entities).toHaveLength(3);
    expect(input.people[0]!.tags).toHaveLength(1);
    expect(input.people[0]!.names).toHaveLength(4);
  });

  it("warms each demo through the pipeline without calling the LLM", async () => {
    const run = vi.fn(async () => {});

    await warmDemos(loadDemos(), run, () => {});

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map((c) => (c as unknown as [{ cityId: string }])[0].cityId)).toEqual(["nyc", "london", "la"]);
  });
});
```

In `server/src/app.test.ts` add:

```ts
  it("lists demo profiles", async () => {
    const demos = await (await createApp(deps()).request("/api/demos")).json();

    expect(demos.map((d: { id: string }) => d.id)).toEqual(["nyc-indie", "london-blend", "la-visit"]);
  });
```

**Step 3: Run** → FAIL.

**Step 4: Implement** `server/src/demos.ts`:

```ts
import { readFileSync } from "node:fs";
import type { ChipOption } from "./resolve.ts";
import type { TransplantInput } from "./transplant.ts";

export interface Demo {
  id: string;
  title: string;
  blurb: string;
  cityId: string;
  mode: "moving" | "visiting";
  people: { label: string; picks: ChipOption[] }[];
}

let cached: Demo[] | undefined;

export function loadDemos(): Demo[] {
  cached ??= JSON.parse(readFileSync(new URL("../data/demos.json", import.meta.url), "utf8")) as Demo[];
  return cached;
}

export const demoInput = (demo: Demo): TransplantInput => ({
  cityId: demo.cityId,
  mode: demo.mode,
  people: demo.people.map(({ label, picks }) => ({
    label,
    names: picks.map((o) => o.name),
    entities: picks.filter((o) => o.kind === "entity").map((o) => o.id),
    tags: picks.filter((o) => o.kind === "concept").map((o) => o.id),
  })),
});

export async function warmDemos(demos: Demo[], run: (input: TransplantInput) => Promise<void>, log: (message: string) => void = console.log) {
  for (const demo of demos) {
    try {
      await run(demoInput(demo));
      log(`Warmed demo ${demo.id}`);
    } catch (error) {
      log(`Demo warm-up failed for ${demo.id}: ${(error as Error).message}`);
    }
  }
}
```

`server/src/app.ts`: `app.get("/api/demos", (c) => c.json(loadDemos()));`

`server/src/main.ts` (after creating `app`):

```ts
const offline: Llm = { json: () => Promise.reject(new Error("warm-up skips the LLM")) };
void warmDemos(loadDemos(), (input) => runTransplant(input, { qloo, llm: offline, hoodsFor: loadHoods }, () => {}));
```

(Import `Llm`, `loadDemos`, `warmDemos`, `runTransplant`.)

**Step 5: Run** → PASS; typecheck clean.

**Step 6: Commit** `git add server scripts/build-demos.ts package.json && git commit -m "Add pre-resolved demo profiles with startup cache warm-up"`

---

### Task 6: Web — guide panel

**Files:** Modify `web/src/types.ts`, `web/src/api.ts`, `web/src/state.ts`, `web/src/state.test.ts`, `web/src/components/Results.tsx`, `web/src/styles.css`; Create `web/src/components/Guide.tsx`, `web/src/components/Guide.test.tsx`.

**Step 1: Failing tests.** Append to `web/src/state.test.ts`:

```ts
  it("tracks guide turns and applies refined places with their filters", () => {
    let s = reducer(initialState(), { type: "guideAsk", text: "quieter" });
    expect(s.guide).toEqual({ busy: true, turns: [{ role: "user", text: "quieter" }] });

    s = reducer(s, { type: "guideReply", reply: "Try Tea Bar.", trace: [{ tool: "find_tags", summary: "Qloo tags for quiet: Quiet" }] });
    expect(s.guide.busy).toBe(false);
    expect(s.guide.turns.at(-1)).toEqual({ role: "guide", text: "Try Tea Bar.", trace: [{ tool: "find_tags", summary: "Qloo tags for quiet: Quiet" }] });

    s = reducer(s, { type: "hoodPlaces", hoodId: "h1", places: [], filters: ["Quiet"] });
    expect(s.placeFilters).toEqual({ h1: ["Quiet"] });
  });
```

`web/src/components/Guide.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Guide } from "./Guide.tsx";

describe("Guide", () => {
  it("sends quick prompts and typed questions, and shows the agent's Qloo tool trace", async () => {
    const onAsk = vi.fn();
    render(
      <Guide
        hoodName="Greenpoint"
        guide={{
          busy: false,
          turns: [
            { role: "user", text: "quieter" },
            { role: "guide", text: "Try Tea Bar.", trace: [{ tool: "find_places", summary: "6 places in Greenpoint · Quiet" }] },
          ],
        }}
        onAsk={onAsk}
      />,
    );

    expect(screen.getByText("Try Tea Bar.")).toBeTruthy();
    expect(screen.getByText(/6 places in greenpoint · quiet/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "More nightlife" }));
    expect(onAsk).toHaveBeenCalledWith("More nightlife");

    await userEvent.type(screen.getByLabelText(/ask your guide/i), "somewhere for brunch{enter}");
    expect(onAsk).toHaveBeenCalledWith("somewhere for brunch");
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`web/src/types.ts` add:

```ts
export type { TraceStep } from "../../server/src/agent.ts";
export type { Demo } from "../../server/src/demos.ts";
export type { RefineAction, RefineInput, RefineResult } from "../../server/src/refine.ts";
```

`web/src/api.ts` add:

```ts
export const refine = (input: RefineInput) => request<RefineResult>("/api/refine", post(input));
export const fetchDemos = () => request<Demo[]>("/api/demos");
export const fetchHealth = () => request<{ ok: boolean; qlooMonthRemaining: number | null; quotaFloor: number }>("/api/health");
```

(extend the type import).

`web/src/state.ts`:
- Import `TraceStep`.
- Add `export interface GuideTurn { role: "user" | "guide"; text: string; trace?: TraceStep[] }`.
- `State` gains `guide: { busy: boolean; turns: GuideTurn[] }`, `placeFilters: Record<string, string[]>`, `demoId?: string`.
- `initialState` adds `guide: { busy: false, turns: [] }, placeFilters: {}`.
- `cleared` adds `guide: { busy: false, turns: [] }, placeFilters: {}`.
- `Action` adds `| { type: "guideAsk"; text: string } | { type: "guideReply"; reply: string; trace: TraceStep[] } | { type: "guideFail"; message: string }` and `hoodPlaces` gains `filters?: string[]`.
- Reducer cases:

```ts
    case "guideAsk":
      return { ...s, guide: { busy: true, turns: [...s.guide.turns, { role: "user", text: a.text }] } };
    case "guideReply":
      return { ...s, guide: { busy: false, turns: [...s.guide.turns, { role: "guide", text: a.reply, trace: a.trace }] } };
    case "guideFail":
      return { ...s, guide: { busy: false, turns: [...s.guide.turns, { role: "guide", text: a.message }] } };
```

and `hoodPlaces`:

```ts
    case "hoodPlaces":
      return {
        ...s,
        placesByHood: { ...s.placesByHood, [a.hoodId]: a.places },
        placeFilters: a.filters ? { ...s.placeFilters, [a.hoodId]: a.filters } : s.placeFilters,
      };
```

`web/src/components/Guide.tsx`:

```tsx
import { useState } from "react";
import type { State } from "../state.ts";

const QUICK = ["Quieter", "More nightlife", "Great coffee", "Good for kids"];

interface Props {
  hoodName: string;
  guide: State["guide"];
  onAsk: (text: string) => void;
}

export function Guide({ hoodName, guide, onAsk }: Props) {
  const [text, setText] = useState("");
  const ask = (value: string) => {
    if (!value.trim() || guide.busy) return;
    onAsk(value.trim());
    setText("");
  };
  return (
    <section className="guide" aria-label="Your local guide">
      <h2 className="section-title">Ask your guide</h2>
      <p className="provenance mono">An AI agent that refines {hoodName} using live Qloo tags and places.</p>
      <div className="guide__quick">
        {QUICK.map((q) => (
          <button key={q} type="button" className="stamp__option" disabled={guide.busy} onClick={() => ask(q)}>
            {q}
          </button>
        ))}
      </div>
      <ol className="guide__turns" aria-live="polite">
        {guide.turns.map((turn, i) => (
          <li key={i} className={`guide__turn guide__turn--${turn.role}`}>
            <p>{turn.text}</p>
            {turn.trace && turn.trace.length > 0 && (
              <ul className="guide__trace mono">
                {turn.trace.map((step, j) => (
                  <li key={j}>↳ {step.summary}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {guide.busy && (
          <li className="guide__turn guide__turn--guide mono" aria-busy="true">
            Checking Qloo…
          </li>
        )}
      </ol>
      <form
        className="guide__form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <label className="eyebrow" htmlFor="guide-input">
          Ask your guide
        </label>
        <input id="guide-input" value={text} maxLength={300} placeholder="e.g. somewhere for brunch" onChange={(e) => setText(e.target.value)} />
      </form>
    </section>
  );
}
```

`web/src/components/Results.tsx`:
- Props gain `onAsk: (text: string) => void`.
- After `<Places …/>` render `<Guide hoodName={active.name} guide={state.guide} onAsk={onAsk} />`.
- In `Places`, accept `filters?: string[]` and render `{filters && filters.length > 0 && <p className="mono">Filtered by Qloo tags: {filters.join(", ")}</p>}` under the title; pass `filters={state.placeFilters[active.id]}`.
- Update `Results.test.tsx` renders with `onAsk={vi.fn()}`.

`web/src/styles.css` append:

```css
.guide {
  margin: 0 0 2.5rem;
  padding: 1.25rem;
  border: 1px solid var(--ink);
  background: var(--paper-2);
}

.guide__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.75rem 0;
}

.guide__turns {
  display: grid;
  gap: 0.75rem;
  margin: 0 0 0.75rem;
  padding: 0;
  list-style: none;
}

.guide__turn p {
  margin: 0;
}

.guide__turn--user {
  justify-self: end;
  max-width: 80%;
  padding: 0.375rem 0.75rem;
  border: 1px dashed var(--stamp);
  color: var(--stamp);
}

.guide__trace {
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
  color: var(--visa);
}

.guide__form input {
  width: 100%;
  margin-top: 0.375rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--ink);
  background: rgb(255 255 255 / 0.5);
}
```

**Step 4: Run** → PASS; typecheck clean.

**Step 5: Commit** `git add web/src && git commit -m "Add guide agent panel with visible Qloo tool trace"`

---

### Task 7: Web — demos, share links, quota banner, App wiring

**Files:** Create `web/src/share.ts`, `web/src/share.test.ts`; Modify `web/src/state.ts`, `web/src/state.test.ts`, `web/src/components/Intake.tsx`, `web/src/components/Results.tsx`, `web/src/App.tsx`, `web/src/App.test.tsx`, `web/src/styles.css`.

**Step 1: Failing tests**

`web/src/share.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "./share.ts";

const payload = {
  cityId: "london",
  mode: "moving" as const,
  people: [
    {
      label: "You",
      picks: [
        { id: "E1", name: "Phoebe Bridgers", type: "artist", kind: "entity" as const },
        { id: "urn:tag:x", name: "Vintage — clothing", type: "urn:tag:y", kind: "concept" as const },
      ],
    },
  ],
};

describe("share", () => {
  it("round-trips picks through a URL-safe token, including non-ASCII names", () => {
    const token = encodeShare(payload);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(token)).toEqual(payload);
  });

  it("rejects malformed tokens", () => {
    expect(decodeShare("not-a-token")).toBeUndefined();
    expect(decodeShare(encodeShare({ ...payload, people: [] }))).toBeUndefined();
  });
});
```

Append to `web/src/state.test.ts`:

```ts
  it("loads a demo or shared payload as confirmed stamps", () => {
    const s = reducer(initialState(), {
      type: "loadPicks",
      demoId: "london-blend",
      payload: {
        cityId: "london",
        mode: "moving",
        people: [
          { label: "You", picks: [{ id: "a", name: "A", type: "artist", kind: "entity" }, { id: "b", name: "B", type: "tv_show", kind: "entity" }, { id: "c", name: "C", type: "urn:tag:x", kind: "concept" }] },
          { label: "Them", picks: [{ id: "d", name: "D", type: "artist", kind: "entity" }, { id: "e", name: "E", type: "movie", kind: "entity" }, { id: "f", name: "F", type: "brand", kind: "entity" }] },
        ],
      },
    });

    expect(s).toMatchObject({ cityId: "london", blend: true, demoId: "london-blend" });
    expect(readyToRun(s)).toBe(true);
    expect(toInput(s).people[1]).toMatchObject({ label: "Them", entities: ["d", "e", "f"] });
  });
```

Append to `web/src/App.test.tsx`: add `refine`, `fetchDemos`, `fetchHealth` to the hoisted `api` mock; in `beforeEach`:

```ts
  api.fetchHealth.mockResolvedValue({ ok: true, qlooMonthRemaining: 9000, quotaFloor: 1500 });
  api.fetchDemos.mockResolvedValue([
    {
      id: "nyc-indie",
      title: "Indie, moving to New York",
      blurb: "Khruangbin, Fleabag, Aesop",
      cityId: "nyc",
      mode: "moving",
      people: [{ label: "You", picks: ["Khruangbin", "Fleabag", "Aesop"].map((n) => ({ id: n, name: n, type: "artist", kind: "entity" })) }],
    },
  ]);
```

and tests:

```ts
  it("runs a demo in one click and offers a share link", async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /indie, moving to new york/i }));

    expect(await screen.findByLabelText(/taste visa/i)).toBeTruthy();
    expect(api.resolveTaste).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /copy share link/i })).toBeTruthy();
  });

  it("auto-runs a demo from ?demo= and warns when quota is low", async () => {
    api.fetchHealth.mockResolvedValue({ ok: true, qlooMonthRemaining: 1600, quotaFloor: 1500 });
    window.history.replaceState(null, "", "/?demo=nyc-indie");
    render(<App />);

    expect(await screen.findByLabelText(/taste visa/i)).toBeTruthy();
    expect(screen.getByText(/live qloo lookups are running low/i)).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`web/src/share.ts`:

```ts
import type { ChipOption } from "./types.ts";

export interface PicksPayload {
  cityId: string;
  mode: "moving" | "visiting";
  people: { label: string; picks: ChipOption[] }[];
}

type Compact = { c: string; m: "moving" | "visiting"; p: { l: string; k: [id: string, name: string, type: string, concept: 0 | 1][] }[] };

const toBase64Url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (token: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(token.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0)));

export function encodeShare(payload: PicksPayload): string {
  const compact: Compact = {
    c: payload.cityId,
    m: payload.mode,
    p: payload.people.map((p) => ({ l: p.label, k: p.picks.map((o) => [o.id, o.name, o.type, o.kind === "concept" ? 1 : 0]) })),
  };
  return toBase64Url(JSON.stringify(compact));
}

export function decodeShare(token: string): PicksPayload | undefined {
  try {
    const c = JSON.parse(fromBase64Url(token)) as Compact;
    if (typeof c.c !== "string" || (c.m !== "moving" && c.m !== "visiting") || !Array.isArray(c.p) || c.p.length < 1 || c.p.length > 2) return undefined;
    return {
      cityId: c.c,
      mode: c.m,
      people: c.p.map((p) => ({
        label: String(p.l).slice(0, 40),
        picks: p.k.slice(0, 15).map(([id, name, type, concept]) => ({ id: String(id), name: String(name), type: String(type), kind: concept ? ("concept" as const) : ("entity" as const) })),
      })),
    };
  } catch {
    return undefined;
  }
}
```

`web/src/state.ts`:
- Import `PicksPayload` from `./share.ts`.
- `Action` adds `| { type: "loadPicks"; payload: PicksPayload; demoId?: string }`.
- Case:

```ts
    case "loadPicks": {
      const people = [0, 1].map((i) => {
        const p = a.payload.people[i];
        const base = s.people[i] ?? person(i === 0 ? "You" : "Them");
        return p
          ? { ...base, label: p.label, text: "", error: undefined, chips: p.picks.map((o) => ({ query: o.name, kind: o.kind, status: "resolved" as const, selected: o, options: [o] })) }
          : { ...base, chips: [] };
      });
      return { ...s, ...cleared, stage: "intake", cityId: a.payload.cityId, mode: a.payload.mode, blend: a.payload.people.length > 1, people, demoId: a.demoId };
    }
```

- Export `toPicks(s: State): PicksPayload` → `{ cityId, mode, people: (blend ? people : people.slice(0,1)).map((p) => ({ label: p.label, picks: confirmed(p) })) }`.

`web/src/components/Intake.tsx`: props gain `demos: Demo[]; onDemo: (demo: Demo) => void`; render at the top of the ticket:

```tsx
        {demos.length > 0 && (
          <div className="ticket__section">
            <p className="eyebrow">Or try a ready-made taste</p>
            <ul className="demos">
              {demos.map((d) => (
                <li key={d.id}>
                  <button type="button" className="demo" onClick={() => onDemo(d)}>
                    <strong>{d.title}</strong>
                    <span className="mono">{d.blurb}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
```

`web/src/components/Results.tsx`: props gain `shareUrl: string`; next to "Try another taste" add:

```tsx
        <button
          type="button"
          className="btn btn--ink"
          onClick={() => {
            void navigator.clipboard?.writeText(shareUrl);
          }}
        >
          Copy share link
        </button>
```

`web/src/App.tsx` — key changes:
- State: `const [demos, setDemos] = useState<Demo[]>([]); const [lowQuota, setLowQuota] = useState(false);`
- Effects on mount: `fetchDemos().then(setDemos).catch(() => {})`; `fetchHealth().then((h) => setLowQuota(h.qlooMonthRemaining !== null && h.qlooMonthRemaining < h.quotaFloor * 2)).catch(() => {})`.
- `run` takes an explicit state: `const run = async (s: State = state) => { dispatch({ type: "runStart" }); … streamTransplant(toInput(s), …) }`.
- `const startPicks = (payload: PicksPayload, demoId?: string) => { const action = { type: "loadPicks", payload, demoId } as const; const next = reducer(state, action); dispatch(action); void run(next); };`
- `onDemo = (d: Demo) => startPicks({ cityId: d.cityId, mode: d.mode, people: d.people }, d.id)`.
- Auto-run once demos/cities load: read `new URLSearchParams(location.search)`; if `demo` matches a loaded demo → `onDemo`; else if `t` decodes → `startPicks(decoded)`. Guard with a `useRef(false)` so it runs once.
- `shareUrl = state.demoId ? `${location.origin}/?demo=${state.demoId}` : `${location.origin}/?t=${encodeShare(toPicks(state))}``.
- `ask = async (text) => { dispatch({ type: "guideAsk", text }); try { const r = await refine({ cityId: state.cityId, people: toInput(state).people, hoods: state.results!.hoods.map(({ id, name }) => ({ id, name })), activeHoodId: state.activeHoodId!, message: text }); dispatch({ type: "guideReply", reply: r.reply, trace: r.trace }); for (const action of r.actions) dispatch(action.type === "places" ? { type: "hoodPlaces", hoodId: action.hoodId, places: action.places, filters: action.filters } : { type: "selectHood", hoodId: action.hoodId }); } catch (error) { dispatch({ type: "guideFail", message: message(error, "The guide is busy. Try again.") }); } }`.
- Banner: `{lowQuota && <p className="banner">Live Qloo lookups are running low — the ready-made tastes always work.</p>}`.
- Pass `demos`, `onDemo` to `Intake`; `onAsk={ask}`, `shareUrl` to `Results`.

`web/src/styles.css` append:

```css
.demos {
  display: grid;
  gap: 0.5rem;
  margin: 0.5rem 0 0;
  padding: 0;
  list-style: none;
}

.demo {
  width: 100%;
  display: grid;
  gap: 0.125rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--ink);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms var(--ease-out);
}

.demo strong {
  font: 400 1.125rem/1.2 var(--display);
}

@media (hover: hover) {
  .demo:hover {
    background: var(--paper-2);
  }
}
```

**Step 4: Run** → PASS; typecheck; `npm run build:web` succeeds.

**Step 5: Commit** `git add web/src && git commit -m "Add one-click demos, share links, and quota banner"`

---

### Task 8: End-to-end browser QA (≈10–20 Qloo calls)

1. Restart `npm run dev` (warm-up logs "Warmed demo …" ×3) and `npm run web`.
2. With `agent-browser` at 1440×900: click each demo; verify visa + map + spots + plan. Open `/?demo=london-blend` directly; verify auto-run, meters, shared tags.
3. Guide: click "Quieter", then type "more nightlife in Williamsburg". Verify the trace lists `find_tags` and `find_places`, spots update with "Filtered by Qloo tags", and the focus switches when asked.
4. Copy share link from a custom (non-demo) run; open it in a new tab; verify it reruns.
5. 390×844 pass; keyboard-only pass through demo buttons, guide quick prompts, input.
6. Screenshots of intake, results, guide; record in the design doc with any fixes (tests first for logic bugs). Commit.

---

## Out of scope for M4 (tracked)

- Beta "any city" (on-demand Overpass + geocoding) — revisit only if time remains after M5.
- Visa image export — share links cover the sharing need.
