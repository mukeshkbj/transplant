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
