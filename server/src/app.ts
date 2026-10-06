import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CITIES } from "./cities.ts";
import { LlmError } from "./llm/llm.ts";
import type { ToolProvider } from "./llm/tools.ts";
import { QlooError } from "./qloo/client.ts";
import { QuotaLowError, type QuotaState } from "./qloo/quota.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { refine, RefineInputSchema } from "./refine.ts";
import { resolveTaste } from "./resolve.ts";
import {
  hoodPlaces,
  PlacesInputSchema,
  runTransplant,
  type TransplantDeps,
  type TransplantEvent,
  TransplantInputSchema,
} from "./transplant.ts";

export interface AppDeps extends TransplantDeps {
  tools: ToolProvider[];
  quota: QuotaState;
  quotaFloor: number;
  limits: { resolve: RateLimiter; transplant: RateLimiter; places: RateLimiter; refine: RateLimiter };
}

const ResolveInput = z.object({ text: z.string().trim().min(1).max(600) });

const clientIp = (c: Context) =>
  c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

export function toPublicError(error: unknown): { code: string; message: string; status: 429 | 502 | 503 | 500 } {
  if (error instanceof QuotaLowError)
    return { code: "QUOTA_LOW", message: "Live Qloo lookups are paused to protect the event quota. Try a demo profile.", status: 503 };
  if (error instanceof QlooError)
    return { code: "QLOO_UNAVAILABLE", message: "Qloo is busy right now. Try again in a moment.", status: error.status === 429 ? 429 : 502 };
  if (error instanceof LlmError) return { code: "LLM_UNAVAILABLE", message: "Our language model is busy. Try again in a moment.", status: 503 };
  console.error(error);
  return { code: "INTERNAL", message: "Something went wrong.", status: 500 };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, qlooMonthRemaining: deps.quota.remaining ?? null, quotaFloor: deps.quotaFloor }));

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
  app.get("/api/cities", (c) => c.json(CITIES.map(({ id, name, beta, bbox }) => ({ id, name, beta: beta === true, bbox }))));

  app.post("/api/places", async (c) => {
    if (!deps.limits.places.allow(clientIp(c))) return c.json({ code: "RATE_LIMITED" }, 429);
    const body = PlacesInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "BAD_REQUEST", issues: body.error.issues }, 400);
    try {
      const places = await hoodPlaces(body.data, deps);
      return places ? c.json({ places }) : c.json({ code: "UNKNOWN_HOOD", message: "That neighborhood isn't in this city." }, 404);
    } catch (error) {
      const { status, ...publicError } = toPublicError(error);
      return c.json(publicError, status);
    }
  });

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
