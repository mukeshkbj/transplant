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
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }));
    const gemini = geminiProvider({ apiKey: "secret", model: "m", fetchImpl });

    const error = (await gemini.json(call).catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/503.*overloaded/);
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("provider timeouts", () => {
  it("aborts a slow provider after timeoutMs so the fallback can run", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const started = Date.now();
    await expect(geminiProvider({ apiKey: "k", model: "m", fetchImpl, timeoutMs: 50 }).json(call)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
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
