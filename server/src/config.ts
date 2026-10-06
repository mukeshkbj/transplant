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
  STATIC_ROOT: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}
