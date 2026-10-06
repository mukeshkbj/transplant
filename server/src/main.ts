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
