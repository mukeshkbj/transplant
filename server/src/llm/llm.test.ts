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
