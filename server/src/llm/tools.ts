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
