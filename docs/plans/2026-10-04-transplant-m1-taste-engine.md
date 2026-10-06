# Transplant M1 — Taste Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans (or subagent-driven-development) to implement task-by-task.

**Goal:** Prove, with real Qloo data for Lisbon, New York and London, that Transplant can rank neighborhoods by *taste* rather than population density — the go/no-go gate for the whole project.

**Architecture:** A throttled, retrying REST client for `hackathon.api.qloo.com` with an SQLite response cache; pure functions that turn heatmap cells into popularity-adjusted "taste lift", assign cells to the nearest named OSM neighborhood, and blend two people's scores. Scripts fetch neighborhood points (Overpass), record Qloo fixtures once (~12 calls), and print a lift report used for the go/no-go decision.

**Tech Stack:** Node 24 (local) / ≥22.19, TypeScript 7.0.2, Vitest 5.0.2, tsx 4.23.15, `node:sqlite`, `@types/node` 24.19.0. No runtime dependencies in M1.

**Design reference:** `docs/plans/2026-10-04-transplant-design.md`.

**Design refinements made while planning (YAGNI):**
- Neighborhoods are OSM `place=suburb|neighbourhood|quarter` *points*; each heatmap cell goes to the nearest point within 1.5 km. No polygons needed, and it works the same for every city.
- The blend uses `min(liftA, liftB)` only. Compare's shared-tag score is the same for every neighborhood, so it can't change the ranking; it stays a UI explanation, not a scoring term.

**Ground rules for the executor:**
- Never print, log, or commit `QLOO_API_KEY`. Scripts read it from `.env` via `node --env-file=.env`.
- Unit tests must make **zero** Qloo calls (monthly quota is 10,000). Only Task 8 calls Qloo, once.
- Run commands from `D:\Qloo` in Git Bash.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`

**Step 1: Create `package.json`**

```json
{
  "name": "transplant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "hoods": "node --import tsx scripts/fetch-hoods.ts",
    "record": "node --env-file=.env --import tsx scripts/record-fixtures.ts",
    "lift-report": "node --import tsx scripts/lift-report.ts"
  }
}
```

**Step 2: Install pinned dev dependencies**

Run: `npm install -D --save-exact typescript@7.0.2 vitest@5.0.2 tsx@4.23.15 @types/node@24.19.0`
Expected: `added N packages`, no errors.

**Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["server", "scripts", "vitest.config.ts"]
}
```

**Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["server/**/*.test.ts"] },
});
```

**Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "Scaffold TypeScript + Vitest project"
```

---

### Task 2: Qloo client — request shape

**Files:**
- Create: `server/src/qloo/client.ts`
- Test: `server/src/qloo/client.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createQlooClient, QlooError } from "./client.ts";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const makeClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
};

const setup = (...responses: Response[]) => {
  const clock = makeClock();
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  const client = createQlooClient({ apiKey: "test-key", fetchImpl, sleep: clock.sleep, now: clock.now });
  return { client, fetchImpl, clock };
};

describe("createQlooClient", () => {
  it("sends the API key header and joins array params", async () => {
    const { client, fetchImpl } = setup(jsonResponse({ ok: 1 }, 200, { "x-month-ratelimit-remaining": "9000" }));

    const res = await client.get("/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": ["A", "B"], take: 50 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aheatmap&signal.interests.entities=A%2CB&take=50",
    );
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe("test-key");
    expect(res).toEqual({ data: { ok: 1 }, monthRemaining: 9000 });
  });
});
```

**Step 2: Run it**

Run: `npx vitest run server/src/qloo/client.test.ts`
Expected: FAIL — cannot resolve `./client.ts`.

**Step 3: Minimal implementation**

```ts
export type QlooParams = Record<string, string | number | readonly string[]>;

export class QlooError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

export interface QlooResponse<T> {
  data: T;
  monthRemaining: number | undefined;
}

export interface QlooClient {
  get<T>(path: string, params: QlooParams): Promise<QlooResponse<T>>;
}

export interface QlooClientOptions {
  apiKey: string;
  baseUrl?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildUrl(baseUrl: string, path: string, params: QlooParams): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, typeof value === "object" ? value.join(",") : String(value));
  }
  return url;
}

export function createQlooClient(options: QlooClientOptions): QlooClient {
  const {
    apiKey,
    baseUrl = "https://hackathon.api.qloo.com",
    minIntervalMs = 250,
    maxRetries = 2,
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
  } = options;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt = Number.NEGATIVE_INFINITY;

  const throttle = async () => {
    const wait = lastAt + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
  };

  const attempt = async <T>(url: URL): Promise<QlooResponse<T>> => {
    for (let i = 0; ; i++) {
      await throttle();
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        if (i < 1) continue;
        throw new QlooError(`Qloo network error: ${(error as Error).message}`, 0, true);
      }
      if (res.ok) {
        const remaining = res.headers.get("x-month-ratelimit-remaining");
        return { data: (await res.json()) as T, monthRemaining: remaining === null ? undefined : Number(remaining) };
      }
      if (res.status === 429 && i < maxRetries) {
        await sleep(Number(res.headers.get("x-second-ratelimit-reset") ?? 1) * 1000);
        continue;
      }
      if (res.status >= 500 && i < 1) continue;
      const body = await res.text();
      throw new QlooError(
        `Qloo ${res.status} on ${url.pathname}: ${body.slice(0, 200)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
  };

  return {
    get<T>(path: string, params: QlooParams) {
      const run = queue.then(() => attempt<T>(buildUrl(baseUrl, path, params)));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
```

**Step 4: Run it**

Run: `npx vitest run server/src/qloo/client.test.ts`
Expected: PASS (1 test).

**Step 5: Commit**

```bash
git add server/src/qloo
git commit -m "Add Qloo REST client with API key header and param encoding"
```

---

### Task 3: Qloo client — throttling, retries, errors

**Files:**
- Modify: `server/src/qloo/client.test.ts` (append inside the `describe`)

**Step 1: Write the failing tests** (append inside `describe("createQlooClient", ...)`)

```ts
  it("spaces sequential calls by minIntervalMs", async () => {
    const { client, clock } = setup(jsonResponse({}), jsonResponse({}));

    await Promise.all([client.get("/search", { query: "a" }), client.get("/search", { query: "b" })]);

    expect(clock.sleeps).toEqual([250]);
  });

  it("waits for the per-second reset and retries on 429", async () => {
    const { client, fetchImpl, clock } = setup(
      jsonResponse({ error_msg: "Rate limit exceeded" }, 429, { "x-second-ratelimit-reset": "0.3" }),
      jsonResponse({ results: [] }),
    );

    const res = await client.get("/search", { query: "Metallica" });

    expect(res.data).toEqual({ results: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toContain(300);
  });

  it("throws a non-retryable QlooError on 400 without retrying", async () => {
    const { client, fetchImpl } = setup(jsonResponse({ errors: [{ message: "take must be <= 50" }] }, 400));

    const error = await client.get("/v2/insights", { take: 200 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QlooError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries consecutive 429s", async () => {
    const limited = () => jsonResponse({}, 429, { "x-second-ratelimit-reset": "0.1" });
    const { client, fetchImpl } = setup(limited(), limited(), limited());

    const error = await client.get("/search", { query: "x" }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps serving the queue after a failed request", async () => {
    const { client } = setup(jsonResponse({}, 404), jsonResponse({ ok: true }));

    await client.get("/nope", {}).catch(() => undefined);
    const res = await client.get("/search", { query: "x" });

    expect(res.data).toEqual({ ok: true });
  });
```

**Step 2: Run them**

Run: `npx vitest run server/src/qloo/client.test.ts`
Expected: PASS (6 tests). The Task 2 implementation already covers this behaviour; these tests lock it in. If any fail, fix `client.ts` until they pass. Do not weaken the tests.

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

**Step 4: Commit**

```bash
git add server/src/qloo/client.test.ts
git commit -m "Test Qloo client throttling, 429 retry, and error paths"
```

---

### Task 4: Persistent response cache

**Files:**
- Create: `server/src/qloo/cache.ts`
- Test: `server/src/qloo/cache.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { cacheKey, withCache } from "./cache.ts";
import type { QlooClient } from "./client.ts";

const fakeInner = () => {
  const get = vi.fn(async (path: string) => ({ data: { path }, monthRemaining: 42 }));
  return { client: { get } as unknown as QlooClient, get };
};

describe("cacheKey", () => {
  it("is independent of param order and joins arrays", () => {
    expect(cacheKey("/v2/insights", { b: 1, a: ["x", "y"] })).toBe(cacheKey("/v2/insights", { a: ["x", "y"], b: 1 }));
    expect(cacheKey("/search", { query: "a b" })).toBe("/search?query=a+b");
  });
});

describe("withCache", () => {
  it("serves repeated requests from SQLite", async () => {
    const { client, get } = fakeInner();
    const cached = withCache(client, ":memory:");

    const first = await cached.get("/search", { query: "Khruangbin" });
    const second = await cached.get("/search", { query: "Khruangbin" });

    expect(get).toHaveBeenCalledTimes(1);
    expect(first.data).toEqual(second.data);
    expect(second.monthRemaining).toBeUndefined();
  });

  it("refetches after the TTL expires", async () => {
    const { client, get } = fakeInner();
    let t = 0;
    const cached = withCache(client, ":memory:", 1000, () => t);

    await cached.get("/search", { query: "x" });
    t = 1001;
    await cached.get("/search", { query: "x" });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ data: 1, monthRemaining: 1 });
    const cached = withCache({ get } as unknown as QlooClient, ":memory:");

    await expect(cached.get("/search", {})).rejects.toThrow("boom");
    await expect(cached.get("/search", {})).resolves.toMatchObject({ data: 1 });
  });
});
```

**Step 2: Run it**

Run: `npx vitest run server/src/qloo/cache.test.ts`
Expected: FAIL — cannot resolve `./cache.ts`.

**Step 3: Minimal implementation**

```ts
import { DatabaseSync } from "node:sqlite";
import type { QlooClient, QlooParams, QlooResponse } from "./client.ts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function cacheKey(path: string, params: QlooParams): string {
  const entries = Object.keys(params)
    .sort()
    .map((key): [string, string] => {
      const value = params[key]!;
      return [key, typeof value === "object" ? value.join(",") : String(value)];
    });
  return `${path}?${new URLSearchParams(entries).toString()}`;
}

export function withCache(inner: QlooClient, dbPath: string, ttlMs = THIRTY_DAYS_MS, now = Date.now): QlooClient {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS qloo_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL)");
  const read = db.prepare("SELECT body, created_at FROM qloo_cache WHERE key = ?");
  const write = db.prepare("INSERT OR REPLACE INTO qloo_cache (key, body, created_at) VALUES (?, ?, ?)");

  return {
    async get<T>(path: string, params: QlooParams): Promise<QlooResponse<T>> {
      const key = cacheKey(path, params);
      const row = read.get(key) as { body: string; created_at: number } | undefined;
      if (row && now() - row.created_at < ttlMs) return { data: JSON.parse(row.body) as T, monthRemaining: undefined };
      const res = await inner.get<T>(path, params);
      write.run(key, JSON.stringify(res.data), now());
      return res;
    },
  };
}
```

**Step 4: Run it**

Run: `npx vitest run server/src/qloo/cache.test.ts && npm run typecheck`
Expected: PASS (4 tests); typecheck clean. (An `ExperimentalWarning` about SQLite is OK.)

**Step 5: Commit**

```bash
git add server/src/qloo/cache.ts server/src/qloo/cache.test.ts
git commit -m "Add SQLite-backed Qloo response cache to protect monthly quota"
```

---

### Task 5: Heatmap parsing and taste lift

**Files:**
- Create: `server/src/geo/heatmap.ts`
- Test: `server/src/geo/heatmap.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { type HeatCell, parseHeatmap, tasteLift } from "./heatmap.ts";

const cell = (geohash: string, popularity: number, affinity: number): HeatCell => ({
  geohash,
  lat: 0,
  lng: 0,
  popularity,
  affinity,
  byType: {},
});

describe("parseHeatmap", () => {
  it("flattens Qloo heatmap cells and extracts per-type affinity", () => {
    const body = {
      results: {
        heatmap: [
          {
            location: { latitude: 38.72, longitude: -9.13, geohash: "eycs21" },
            query: { affinity: 1, affinity_rank: 0.97, popularity: 0.9, entity_artist_affinity: 0.95, entity_tv_show_affinity_rank: 0.99 },
          },
        ],
      },
    };

    expect(parseHeatmap(body)).toEqual([
      { geohash: "eycs21", lat: 38.72, lng: -9.13, affinity: 1, popularity: 0.9, byType: { artist: 0.95 } },
    ]);
  });

  it("returns [] for an empty or missing heatmap", () => {
    expect(parseHeatmap({})).toEqual([]);
  });
});

describe("tasteLift", () => {
  it("ranks cells by affinity beyond what popularity predicts", () => {
    const cells = [
      cell("dense", 1.0, 1.0),
      cell("mid", 0.6, 0.6),
      cell("tasty", 0.5, 0.75),
      cell("quiet", 0.4, 0.4),
    ];

    const lifted = tasteLift(cells, 0.3);

    expect(lifted[0]!.geohash).toBe("tasty");
    expect(lifted[0]!.lift).toBeGreaterThan(0.1);
    expect(lifted.find((c) => c.geohash === "dense")!.lift).toBeLessThan(lifted[0]!.lift);
  });

  it("drops cells below the popularity floor", () => {
    const cells = [cell("a", 0.9, 0.9), cell("b", 0.5, 0.5), cell("sparse", 0.1, 0.9)];

    expect(tasteLift(cells, 0.3).map((c) => c.geohash)).not.toContain("sparse");
  });
});
```

**Step 2: Run it**

Run: `npx vitest run server/src/geo/heatmap.test.ts`
Expected: FAIL — cannot resolve `./heatmap.ts`.

**Step 3: Minimal implementation**

```ts
export interface HeatCell {
  geohash: string;
  lat: number;
  lng: number;
  affinity: number;
  popularity: number;
  byType: Record<string, number>;
}

export interface LiftCell extends HeatCell {
  lift: number;
}

interface RawHeatCell {
  location: { latitude: number; longitude: number; geohash: string };
  query: Record<string, number>;
}

const TYPE_AFFINITY = /^entity_(.+)_affinity$/;

export function parseHeatmap(body: { results?: { heatmap?: RawHeatCell[] } }): HeatCell[] {
  return (body.results?.heatmap ?? []).map(({ location, query }) => ({
    geohash: location.geohash,
    lat: location.latitude,
    lng: location.longitude,
    affinity: query.affinity ?? 0,
    popularity: query.popularity ?? 0,
    byType: Object.fromEntries(
      Object.entries(query).flatMap(([key, value]) => {
        const match = TYPE_AFFINITY.exec(key);
        return match ? [[match[1]!, value]] : [];
      }),
    ),
  }));
}

export function tasteLift(cells: HeatCell[], popularityFloor = 0.3): LiftCell[] {
  const n = cells.length;
  if (n === 0) return [];
  const meanPop = cells.reduce((sum, c) => sum + c.popularity, 0) / n;
  const meanAff = cells.reduce((sum, c) => sum + c.affinity, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const c of cells) {
    sxy += (c.popularity - meanPop) * (c.affinity - meanAff);
    sxx += (c.popularity - meanPop) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return cells
    .filter((c) => c.popularity >= popularityFloor)
    .map((c) => ({ ...c, lift: c.affinity - (meanAff + slope * (c.popularity - meanPop)) }))
    .sort((a, b) => b.lift - a.lift);
}
```

**Step 4: Run it**

Run: `npx vitest run server/src/geo/heatmap.test.ts && npm run typecheck`
Expected: PASS (4 tests); typecheck clean.

**Step 5: Commit**

```bash
git add server/src/geo
git commit -m "Add heatmap parsing and popularity-adjusted taste lift"
```

---

### Task 6: Neighborhood scoring and blend

**Files:**
- Create: `server/src/geo/hoods.ts`
- Test: `server/src/geo/hoods.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { LiftCell } from "./heatmap.ts";
import { blendHoods, type Hood, haversineKm, scoreHoods } from "./hoods.ts";

const hoods: Hood[] = [
  { id: "arroios", name: "Arroios", lat: 38.73, lng: -9.135 },
  { id: "alfama", name: "Alfama", lat: 38.711, lng: -9.13 },
];

const lc = (lat: number, lng: number, lift: number, popularity = 0.5, byType: Record<string, number> = {}): LiftCell => ({
  geohash: `${lat},${lng}`,
  lat,
  lng,
  lift,
  popularity,
  affinity: 0,
  byType,
});

describe("haversineKm", () => {
  it("measures ~2.1 km between Arroios and Alfama", () => {
    expect(haversineKm(hoods[0]!, hoods[1]!)).toBeCloseTo(2.15, 1);
  });
});

describe("scoreHoods", () => {
  it("assigns cells to the nearest hood and ranks by popularity-weighted lift", () => {
    const cells = [
      lc(38.7305, -9.1352, 0.2, 1.0, { artist: 0.9 }),
      lc(38.7298, -9.1345, 0.0, 1.0, { artist: 0.7 }),
      lc(38.7112, -9.1301, 0.05, 0.5),
    ];

    const scores = scoreHoods(cells, hoods);

    expect(scores.map((s) => s.hood.id)).toEqual(["arroios", "alfama"]);
    expect(scores[0]).toMatchObject({ cellCount: 2 });
    expect(scores[0]!.lift).toBeCloseTo(0.1);
    expect(scores[0]!.byType.artist).toBeCloseTo(0.8);
  });

  it("ignores cells farther than maxKm from every hood", () => {
    expect(scoreHoods([lc(38.8, -9.44, 0.9)], hoods)).toEqual([]);
  });
});

describe("blendHoods", () => {
  it("ranks hoods that suit both people above one person's favourite", () => {
    const a = [
      { hood: hoods[0]!, lift: 0.3, cellCount: 1, byType: {} },
      { hood: hoods[1]!, lift: 0.1, cellCount: 1, byType: {} },
    ];
    const b = [
      { hood: hoods[0]!, lift: -0.1, cellCount: 1, byType: {} },
      { hood: hoods[1]!, lift: 0.08, cellCount: 1, byType: {} },
    ];

    expect(blendHoods(a, b).map((s) => [s.hood.id, s.score])).toEqual([
      ["alfama", 0.08],
      ["arroios", -0.1],
    ]);
  });
});
```

**Step 2: Run it**

Run: `npx vitest run server/src/geo/hoods.test.ts`
Expected: FAIL — cannot resolve `./hoods.ts`.

**Step 3: Minimal implementation**

```ts
import type { LiftCell } from "./heatmap.ts";

export interface Hood {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface HoodScore {
  hood: Hood;
  lift: number;
  cellCount: number;
  byType: Record<string, number>;
}

export interface BlendScore {
  hood: Hood;
  score: number;
  a: number;
  b: number;
}

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const nearest = (cell: LiftCell, hoods: Hood[], maxKm: number): Hood | undefined => {
  let best: Hood | undefined;
  let bestKm = maxKm;
  for (const hood of hoods) {
    const km = haversineKm(cell, hood);
    if (km <= bestKm) {
      best = hood;
      bestKm = km;
    }
  }
  return best;
};

export function scoreHoods(cells: LiftCell[], hoods: Hood[], maxKm = 1.5): HoodScore[] {
  const groups = new Map<Hood, LiftCell[]>();
  for (const cell of cells) {
    const hood = nearest(cell, hoods, maxKm);
    if (hood) groups.set(hood, [...(groups.get(hood) ?? []), cell]);
  }
  return [...groups].map(([hood, group]) => {
    const weight = group.reduce((sum, c) => sum + c.popularity, 0) || 1;
    const byType: Record<string, number> = {};
    for (const type of new Set(group.flatMap((c) => Object.keys(c.byType)))) {
      const values = group.flatMap((c) => (type in c.byType ? [c.byType[type]!] : []));
      byType[type] = values.reduce((sum, v) => sum + v, 0) / values.length;
    }
    return {
      hood,
      lift: group.reduce((sum, c) => sum + c.lift * c.popularity, 0) / weight,
      cellCount: group.length,
      byType,
    };
  }).sort((x, y) => y.lift - x.lift);
}

export function blendHoods(a: HoodScore[], b: HoodScore[]): BlendScore[] {
  const byId = new Map(b.map((s) => [s.hood.id, s]));
  return a
    .flatMap((sa) => {
      const sb = byId.get(sa.hood.id);
      return sb ? [{ hood: sa.hood, a: sa.lift, b: sb.lift, score: Math.min(sa.lift, sb.lift) }] : [];
    })
    .sort((x, y) => y.score - x.score);
}
```

**Step 4: Run it**

Run: `npx vitest run && npm run typecheck`
Expected: all suites PASS (17 tests); typecheck clean.

**Step 5: Commit**

```bash
git add server/src/geo/hoods.ts server/src/geo/hoods.test.ts
git commit -m "Add nearest-neighborhood scoring and min-based taste blend"
```

---

### Task 7: City registry and OSM neighborhood points

**Files:**
- Create: `server/src/cities.ts`, `scripts/fetch-hoods.ts`
- Generated: `server/data/hoods/{lisbon,nyc,london}.json`

**Step 1: Create `server/src/cities.ts`**

```ts
export interface City {
  id: string;
  name: string;
  /** Free-text location sent to Qloo `filter.location.query`. */
  query: string;
  /** [south, west, north, east] used to fetch OSM neighborhood points. */
  bbox: [number, number, number, number];
}

export const CITIES: City[] = [
  { id: "lisbon", name: "Lisbon", query: "Lisbon", bbox: [38.69, -9.23, 38.8, -9.09] },
  { id: "nyc", name: "New York City", query: "New York City", bbox: [40.49, -74.26, 40.92, -73.7] },
  { id: "london", name: "London", query: "London", bbox: [51.28, -0.51, 51.69, 0.33] },
];
```

**Step 2: Create `scripts/fetch-hoods.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { CITIES } from "../server/src/cities.ts";
import type { Hood } from "../server/src/geo/hoods.ts";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

await mkdir("server/data/hoods", { recursive: true });

for (const city of CITIES) {
  const [south, west, north, east] = city.bbox;
  const query = `[out:json][timeout:90];node["place"~"^(suburb|neighbourhood|quarter)$"]["name"](${south},${west},${north},${east});out body;`;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    headers: { "User-Agent": "transplant-hackathon/0.1 (Qloo Agentic Hackathon)" },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status} for ${city.id}`);
  const { elements } = (await res.json()) as { elements: OsmNode[] };
  const hoods: Hood[] = elements.map((el) => ({ id: `osm:${el.id}`, name: el.tags.name!, lat: el.lat, lng: el.lon }));
  await writeFile(`server/data/hoods/${city.id}.json`, `${JSON.stringify(hoods, null, 1)}\n`);
  console.log(`${city.id}: ${hoods.length} neighborhoods`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
```

**Step 3: Run it**

Run: `npm run hoods`
Expected: three lines like `lisbon: 60 neighborhoods`, each with a count > 20. If Overpass returns 429/504, wait a minute and rerun.

**Step 4: Spot-check**

Run: `node -e "const h=require('./server/data/hoods/lisbon.json');console.log(h.filter(x=>/Arroios|Alfama|Bairro Alto|Intendente/.test(x.name)).map(x=>x.name))"`
Expected: at least two of those names.

**Step 5: Commit**

```bash
npm run typecheck
git add server/src/cities.ts scripts/fetch-hoods.ts server/data/hoods
git commit -m "Add city registry and OSM neighborhood points for Lisbon, NYC, London"
```

Data © OpenStreetMap contributors (ODbL); attribution goes into the README in a later milestone.

---

### Task 8: Record Qloo fixtures (only live Qloo step, ~12 calls)

**Prerequisite:** `D:\Qloo\.env` exists with `QLOO_API_KEY=...` (the user creates it; never echo it).

**Files:**
- Create: `scripts/record-fixtures.ts`
- Generated: `server/test/fixtures/heatmap-{indie,mainstream}-{lisbon,nyc,london}.json`

**Step 1: Create `scripts/record-fixtures.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { CITIES } from "../server/src/cities.ts";
import { createQlooClient } from "../server/src/qloo/client.ts";

const PROFILES: Record<string, [query: string, type: string][]> = {
  indie: [
    ["Khruangbin", "urn:entity:artist"],
    ["Fleabag", "urn:entity:tv_show"],
    ["Aesop", "urn:entity:brand"],
  ],
  mainstream: [
    ["Metallica", "urn:entity:artist"],
    ["Top Gun: Maverick", "urn:entity:movie"],
    ["Harley-Davidson", "urn:entity:brand"],
  ],
};

const apiKey = process.env.QLOO_API_KEY;
if (!apiKey) throw new Error("QLOO_API_KEY is missing. Create .env from .env.example.");
const qloo = createQlooClient({ apiKey, baseUrl: process.env.QLOO_BASE_URL });

await mkdir("server/test/fixtures", { recursive: true });
let remaining: number | undefined;

for (const [profile, items] of Object.entries(PROFILES)) {
  const ids: string[] = [];
  for (const [query, types] of items) {
    const { data } = await qloo.get<{ results: { entity_id: string; name: string }[] }>("/search", { query, types, take: 1 });
    const hit = data.results[0];
    if (!hit) throw new Error(`No Qloo match for ${query}`);
    console.log(`${profile}: ${query} -> ${hit.name}`);
    ids.push(hit.entity_id);
  }
  for (const city of CITIES) {
    const res = await qloo.get("/v2/insights", {
      "filter.type": "urn:heatmap",
      "signal.interests.entities": ids,
      "filter.location.query": city.query,
      take: 50,
    });
    remaining = res.monthRemaining;
    await writeFile(`server/test/fixtures/heatmap-${profile}-${city.id}.json`, JSON.stringify(res.data));
    console.log(`${profile}/${city.id}: saved`);
  }
}

console.log(`Done. Monthly Qloo quota remaining: ${remaining}`);
```

**Step 2: Run it once**

Run: `npm run record`
Expected: 6 `-> <name>` lines, 6 `saved` lines, `Monthly Qloo quota remaining: ~99xx`. Do **not** rerun unless it failed.

**Step 3: Check that the fixtures have data**

Run: `node -e "for (const f of require('fs').readdirSync('server/test/fixtures')) console.log(f, require('./server/test/fixtures/'+f).results.heatmap.length)"`
Expected: every file > 50 cells. If NYC is ~0, change its `query` to `"New York"` in `cities.ts` and rerun **only** the NYC heatmaps.

**Step 4: Commit**

```bash
git add scripts/record-fixtures.ts server/test/fixtures
git commit -m "Record Qloo heatmap fixtures for two contrasting taste profiles"
```

---

### Task 9: Lift report and go/no-go gate

**Files:**
- Create: `scripts/lift-report.ts`

**Step 1: Create `scripts/lift-report.ts`**

```ts
import { readFileSync } from "node:fs";
import { CITIES } from "../server/src/cities.ts";
import { parseHeatmap, tasteLift } from "../server/src/geo/heatmap.ts";
import { type Hood, type HoodScore, scoreHoods } from "../server/src/geo/hoods.ts";

const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fmt = (scores: HoodScore[]) =>
  scores.map((s) => `${s.hood.name} (${s.lift.toFixed(3)}, ${s.cellCount}c)`).join(" | ");

let passes = 0;
for (const city of CITIES) {
  const hoods = load<Hood[]>(`server/data/hoods/${city.id}.json`);
  const top = (profile: string) =>
    scoreHoods(tasteLift(parseHeatmap(load(`server/test/fixtures/heatmap-${profile}-${city.id}.json`))), hoods).slice(0, 3);
  const indie = top("indie");
  const mainstream = top("mainstream");
  const overlap = indie.filter((x) => mainstream.some((y) => y.hood.id === x.hood.id)).length;
  const pass = indie.length === 3 && mainstream.length === 3 && overlap <= 1;
  if (pass) passes++;
  console.log(`\n${city.name}\n  indie:      ${fmt(indie)}\n  mainstream: ${fmt(mainstream)}\n  overlap ${overlap}/3 -> ${pass ? "PASS" : "FAIL"}`);
}
console.log(`\n${passes}/${CITIES.length} cities pass`);
```

**Step 2: Run it**

Run: `npm run lift-report`
Expected: a per-city block and `N/3 cities pass`.

**Step 3: Go/no-go decision (report to the user and stop here)**

**GO** if all of these hold:
1. 3/3 cities PASS (top-3 overlap ≤ 1).
2. The indie profile lands in recognisably creative or independent districts (e.g. Lisbon: Arroios / Intendente / Bairro Alto / Príncipe Real; NYC: Williamsburg / Bushwick / Lower East Side / Greenpoint; London: Hackney / Dalston / Shoreditch / Peckham).
3. Every top-3 hood has ≥ 2 cells.

**If NO-GO**, tune using fixtures only (zero quota) in this order, rerunning the report after each change:
1. `popularityFloor` in `tasteLift` (try 0.4, 0.5).
2. `maxKm` in `scoreHoods` (try 1.0, 2.0).
3. Require `cellCount >= 2` before ranking.
4. Score with `affinity_rank` instead of `affinity` (add it to `parseHeatmap`).

Record the chosen parameters and the final report output in `docs/plans/2026-10-04-transplant-design.md` under "Verified API facts".

**Step 4: Commit**

```bash
git add scripts/lift-report.ts docs/plans
git commit -m "Add lift report and record M1 go/no-go result"
```

---

## Later milestones (detailed plans written when M1 passes)

- **M2 (Oct 9–14):** Express API + SSE pipeline (`/api/resolve`, `/api/transplant`), place insights per hood, Gemini parse/explain with evidence-constrained JSON output, hood data for all 12 cities.
- **M3 (Oct 15–20):** React + Vite + MapLibre UI: chips with disambiguation, heatmap layer, ranked hoods, spots, Moving/Visiting sections.
- **M4 (Oct 21–24):** Blend mode with `/v2/analysis/compare` explanations, refine chat, warmed demo profiles, quota banner.
- **M5 (Oct 25–27):** Dockerfile + Fly.io (volume for SQLite, secrets), public GitHub repo with MIT LICENSE, README (setup, OSM attribution, limitations), Playwright E2E.
- **M6 (Oct 28–29):** Devpost submission via the `devpost-submission` skill; buffer.
