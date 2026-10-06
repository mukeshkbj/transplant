import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { loadHoods } from "./hoods-data.ts";
import { loadDemos, warmDemos } from "./demos.ts";
import { createLlm, type Llm } from "./llm/llm.ts";
import { geminiProvider, groqProvider } from "./llm/providers.ts";
import { geminiTools, groqTools } from "./llm/tools.ts";
import { withCache } from "./qloo/cache.ts";
import { createQlooClient } from "./qloo/client.ts";
import { type QuotaState, withQuotaGuard } from "./qloo/quota.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { runTransplant } from "./transplant.ts";

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

const tools = [
  ...(config.GROQ_API_KEY ? [groqTools({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL })] : []),
  geminiTools({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }),
];

const app = createApp({
  qloo,
  llm,
  tools,
  quota,
  quotaFloor: config.QUOTA_FLOOR,
  hoodsFor: loadHoods,
  limits: {
    resolve: createRateLimiter(30, HOUR_MS),
    transplant: createRateLimiter(6, HOUR_MS),
    places: createRateLimiter(30, HOUR_MS),
    refine: createRateLimiter(20, HOUR_MS),
  },
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`Transplant API listening on http://localhost:${info.port}`));

const offline: Llm = { json: () => Promise.reject(new Error("warm-up skips the LLM")) };
void warmDemos(loadDemos(), (input) => runTransplant(input, { qloo, llm: offline, hoodsFor: loadHoods }, () => {}));
