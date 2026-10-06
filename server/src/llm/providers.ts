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
