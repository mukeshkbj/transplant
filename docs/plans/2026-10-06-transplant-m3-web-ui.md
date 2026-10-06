# Transplant M3 — Web UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans (or subagent-driven-development) to implement task-by-task.

**Goal:** A judge opens one page, types what they love, confirms their taste stamps, and watches their neighborhood light up on a night map with editorial write-ups, local spots, and a first-week plan — solo or blended with a second person.

**Architecture:** React 19 + Vite SPA in `web/`, proxied to the M2 Hono API in dev. One `useReducer` state machine (`intake → running → results`) driven by API calls and the SSE event stream. Server types are imported type-only from `server/src`, so client and API share one contract. MapLibre GL renders OpenFreeMap's key-less `dark` style with a heatmap layer of taste-lift cells and clickable hood pins; it is isolated in `MapView` and mocked in jsdom tests. Two small server changes: place labels + sharper story prompt, and `POST /api/places` for hoods #2/#3.

**Tech Stack:** react/react-dom 19.3.0, vite 8.3.1, @vitejs/plugin-react 6.1.1, maplibre-gl 6.11.2, @testing-library/react 16.3.3 (+ @testing-library/dom, user-event 14.6.7), jsdom 30.1.1, @types/react(-dom) 19.3.0, fonts @fontsource/gloock 5.3.0, @fontsource-variable/newsreader 5.3.0, @fontsource/ibm-plex-mono 5.3.0. All published ≥7 days before 2026-10-06. Tiles: `https://tiles.openfreemap.org/styles/dark` (verified 200, no key).

## Design direction (user chose A + B + C; fused as one journey)

| Moment | Motif | Treatment |
| --- | --- | --- |
| Intake | **Editorial field guide (A)** | Warm paper (`#f3ede2`) with grain, masthead "TRANSPLANT — a field guide to where your taste lives", Gloock display serif, Newsreader body. |
| Taste confirmation | **Passport (C)** | Each resolved chip is an ink *stamp* (vermilion `#c2410c`, dashed ring, slight tilt, "thunk" scale-in). Ambiguous = "Which 'Lost'?" stamp with options. Missing = voided stamp. |
| Running | **Passport (C)** | Boarding pass: "Now boarding · New York City" with step rows ticking off from SSE. |
| Results | **Night map (B)** + **Editorial (A)** + **Visa (C)** | Split screen: left = magazine features "No. 1 Greenpoint" with headline/why + taste-lift facts; right = sticky dark map with amber heat glow and pins. Top hood gets a green *Taste Visa* stamped "ADMITTED". |

Type: Gloock (display), Newsreader Variable (body), IBM Plex Mono (labels, data, stamps). Motion: one staggered reveal on results, stamp scale-in, map fly-to; all disabled under `prefers-reduced-motion`. Provenance always visible: "Qloo match" badges on data, "Written by AI from Qloo evidence" under prose, OSM attribution and aggregate-affinity disclaimer in the colophon.

**Ground rules:** No secrets in the client (it only calls `/api/*`). Tests make zero network calls (API module and `MapView` are mocked). Run from `D:\Qloo` in Git Bash; after each task `npx vitest run && npm run typecheck`.

---

### Task 1: Place labels and a sharper story prompt (server)

**Files:** Modify `server/src/places.ts`, `server/src/places.test.ts`, `server/src/story.ts`, `server/src/story.test.ts`.

**Step 1: Failing tests.** Append to `server/src/places.test.ts`:

```ts
import { placeLabel } from "./places.ts";

describe("placeLabel", () => {
  it("turns the primary genre into a readable label", () => {
    expect(placeLabel({ genre: "urn:tag:genre:place:comic_book_store", categories: [] })).toBe("Comic book store");
    expect(placeLabel({ genre: "urn:tag:genre:place:restaurant:cocktail_bar", categories: [] })).toBe("Cocktail bar");
  });

  it("falls back to the first category, then 'Place'", () => {
    expect(placeLabel({ genre: "", categories: ["Cafe"] })).toBe("Cafe");
    expect(placeLabel({ genre: "", categories: [] })).toBe("Place");
  });
});
```

(Merge the import into the existing `./places.ts` import line.)

Append to `server/src/story.test.ts` inside `describe("writeStory")`:

```ts
  it("gives the LLM place labels and uses them in template notes", async () => {
    const { llm, requests } = fakeLlm(() => {
      throw new Error("down");
    });

    const { story } = await writeStory({ ...base, llm });

    expect(requests[0]!.system).toMatch(/name the place/i);
    expect(JSON.parse(requests[0]!.prompt).places[0]).toMatchObject({ placeId: "p1", label: "Comic book store" });
    expect(story.plan[0]!.note).toBe("Comic book store");
  });
```

**Step 2: Run** `npx vitest run server/src/places.test.ts server/src/story.test.ts` → FAIL (`placeLabel` missing; prompt lacks rule).

**Step 3: Implement.** Add to `server/src/places.ts`:

```ts
export function placeLabel(place: Pick<Place, "genre" | "categories">): string {
  const words = (place.genre.replace("urn:tag:genre:place:", "").split(":").at(-1) ?? "").replaceAll("_", " ").trim();
  if (words) return words[0]!.toUpperCase() + words.slice(1);
  return place.categories[0] ?? "Place";
}
```

In `server/src/story.ts`:
- `import { placeLabel } from "./places.ts";`
- Evidence places: `places.map((p) => ({ placeId: p.id, name: p.name, label: placeLabel(p), categories: p.categories, neighborhood: p.neighborhood }))`
- Template plan note: `note: placeLabel(p)`
- Replace the `plan:` rule line in `SYSTEM` with:

```
- plan: 5 entries using only placeIds from evidence. note <= 16 words: name the place and what it is (use its label), and tie it to their taste, e.g. "Coffee at Land to Sea, a cafe-wine bar your natural-wine side will like". mode "moving": a first week ("Day 1".."Day 5") mixing a coffee spot, an evening out, and a weekend browse. mode "visiting": "Morning"/"Afternoon"/"Evening" stops.
```

**Step 4: Run** → PASS; full suite + typecheck clean.

**Step 5: Commit** `git commit -am "Label places by genre and require named places in story plans"`

---

### Task 2: `/api/cities` bbox and `POST /api/places` (server)

**Files:** Modify `server/src/transplant.ts`, `server/src/app.ts`, `server/src/app.test.ts`, `server/src/main.ts`.

**Step 1: Failing tests.** In `server/src/app.test.ts`:
- Add `places: createRateLimiter(limit, 60_000)` to `limits` in `deps()`.
- Replace the cities expectation with:

```ts
    expect(await (await app.request("/api/cities")).json()).toEqual(
      expect.arrayContaining([
        { id: "nyc", name: "New York City", beta: false, bbox: [40.49, -74.26, 40.92, -73.7] },
        expect.objectContaining({ id: "tokyo", beta: true }),
      ]),
    );
```

- Add:

```ts
  it("returns curated places for another hood and 404s unknown hoods", async () => {
    const app = createApp(deps());
    const greenpoint = loadHoods(CITIES.find((c) => c.id === "nyc")!).find((h) => h.name === "Greenpoint")!;
    const people = transplantBody.people;

    const ok = await app.request("/api/places", post({ cityId: "nyc", hoodId: greenpoint.id, people }));
    expect((await ok.json()).places.map((p: { name: string }) => p.name)).toContain("Desert Island");
    expect((await app.request("/api/places", post({ cityId: "nyc", hoodId: "osm:nope", people }))).status).toBe(404);
  });
```

  (add `import { CITIES } from "./cities.ts";`)

**Step 2: Run** `npx vitest run server/src/app.test.ts` → FAIL.

**Step 3: Implement.** In `server/src/transplant.ts` add:

```ts
export const PlacesInputSchema = z.object({
  cityId: z.string().max(40),
  hoodId: z.string().max(80),
  people: TransplantInputSchema.shape.people,
});

export type PlacesInput = z.infer<typeof PlacesInputSchema>;

export async function hoodPlaces(input: PlacesInput, deps: TransplantDeps): Promise<Place[] | undefined> {
  const city = CITIES.find((c) => c.id === input.cityId);
  const hood = city ? deps.hoodsFor(city).find((h) => h.id === input.hoodId) : undefined;
  if (!hood) return undefined;
  return curatePlaces(await placesNear(deps.qloo, union(input.people), hood));
}
```

In `server/src/app.ts`:
- `limits: { resolve: RateLimiter; transplant: RateLimiter; places: RateLimiter }`
- Cities: `CITIES.map(({ id, name, beta, bbox }) => ({ id, name, beta: beta === true, bbox }))`
- Import `hoodPlaces, PlacesInputSchema` and add:

```ts
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
```

In `server/src/main.ts` add `places: createRateLimiter(30, HOUR_MS)` to `limits`.

**Step 4: Run** → PASS; typecheck clean.

**Step 5: Commit** `git commit -am "Expose city bboxes and per-hood places endpoint"`

---

### Task 3: Web scaffold

**Files:** Modify `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`; Create `vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx` (placeholder), `web/src/test-setup.ts`, `web/src/App.test.tsx`.

**Step 1: Install**

```bash
npm install --save-exact react@19.3.0 react-dom@19.3.0 maplibre-gl@6.11.2 @fontsource/gloock@5.3.0 @fontsource-variable/newsreader@5.3.0 @fontsource/ibm-plex-mono@5.3.0
npm install -D --save-exact vite@8.3.1 @vitejs/plugin-react@6.1.1 @testing-library/react@16.3.3 @testing-library/user-event@14.6.7 jsdom@30.1.1 @types/react@19.3.0 @types/react-dom@19.3.0
```

If npm reports a missing `@testing-library/dom` peer, install the newest version published ≥7 days ago with `--save-exact -D`.

**Step 2: Config**

`package.json` scripts — add:

```json
"web": "vite",
"build:web": "vite build",
```

`.gitignore` — `dist/` is already ignored.

`tsconfig.json` compilerOptions — set `"lib": ["es2023", "dom", "dom.iterable"]`, `"jsx": "react-jsx"`, `"types": ["node", "vite/client"]`; `include` → `["server", "scripts", "web", "vitest.config.ts", "vite.config.ts"]`.

`vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
```

`vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "server", include: ["server/**/*.test.ts"], environment: "node" } },
      {
        plugins: [react()],
        test: { name: "web", include: ["web/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["web/src/test-setup.ts"] },
      },
    ],
  },
});
```

`web/src/test-setup.ts`:

```ts
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Transplant finds the neighborhood where your taste already lives, powered by Qloo's taste graph." />
    <title>Transplant — where your taste lives</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:

```tsx
import "@fontsource/gloock";
import "@fontsource-variable/newsreader";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Placeholder `web/src/App.tsx` (replaced in Task 9) and an empty `web/src/styles.css`:

```tsx
export function App() {
  return <h1>Transplant</h1>;
}
```

**Step 3: Smoke test** `web/src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";

describe("App", () => {
  it("renders the masthead", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /transplant/i })).toBeTruthy();
  });
});
```

**Step 4: Run** `npx vitest run && npm run typecheck && npm run build:web` → server + web projects PASS; build writes `dist/web/index.html`.

**Step 5: Commit** `git add -A web vite.config.ts vitest.config.ts tsconfig.json package.json package-lock.json && git commit -m "Scaffold React + Vite web app with jsdom test project"`

---

### Task 4: Design tokens and styles

**Files:** Write `web/src/styles.css` (complete; components in later tasks use these class names).

```css
:root {
  --paper: #f3ede2;
  --paper-2: #e9e0cf;
  --ink: #1b1a17;
  --muted: #6b645a;
  --rule: #d4c8b3;
  --stamp: #c2410c;
  --stamp-wash: rgb(194 65 12 / 0.08);
  --visa: #1f4d3a;
  --visa-wash: #e4ebe2;
  --night: #0e1015;
  --night-ink: #e9e4da;
  --glow: #f59e0b;
  --display: "Gloock", "Times New Roman", serif;
  --serif: "Newsreader Variable", Georgia, serif;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.06'/%3E%3C/svg%3E");
  color-scheme: light;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
}

body {
  background: var(--paper) var(--grain);
  color: var(--ink);
  font: 400 1.0625rem/1.55 var(--serif);
  -webkit-font-smoothing: antialiased;
}

button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
}

:focus-visible {
  outline: 2px solid var(--stamp);
  outline-offset: 2px;
}

.mono {
  font-family: var(--mono);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.eyebrow {
  font: 500 0.75rem/1.2 var(--mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

/* Masthead */
.masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem clamp(1rem, 4vw, 3rem) 0.75rem;
  border-bottom: 1px solid var(--ink);
}

.masthead__title {
  margin: 0;
  font: 400 clamp(1.75rem, 4vw, 2.5rem) / 1 var(--display);
  letter-spacing: 0.02em;
}

.masthead__title button {
  all: unset;
  cursor: pointer;
}

.masthead__issue {
  color: var(--muted);
}

/* Intake: editorial cover + ticket */
.cover {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: clamp(1.5rem, 5vw, 4rem);
  padding: clamp(1.5rem, 5vw, 4rem) clamp(1rem, 4vw, 3rem);
  max-width: 1280px;
  margin: 0 auto;
}

.cover__headline {
  margin: 0.5rem 0 1rem;
  font: 400 clamp(2.5rem, 6.5vw, 5.25rem) / 0.95 var(--display);
  text-wrap: balance;
}

.cover__dek {
  max-width: 34ch;
  font-size: 1.25rem;
  color: var(--muted);
}

.ticket {
  display: grid;
  gap: 1.5rem;
  align-content: start;
}

.ticket__section {
  border-top: 1px solid var(--ink);
  padding-top: 0.75rem;
}

.destinations {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: 0.375rem;
  margin: 0.5rem 0 0;
  padding: 0;
  list-style: none;
}

.destination {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--rule);
  background: transparent;
  font: 500 0.8125rem/1.2 var(--mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out);
}

.destination[aria-pressed="true"] {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper);
}

.destination__beta {
  font-size: 0.625rem;
  color: var(--stamp);
}

.destination[aria-pressed="true"] .destination__beta {
  color: var(--glow);
}

.segmented {
  display: inline-flex;
  margin-top: 0.5rem;
  border: 1px solid var(--ink);
}

.segmented button {
  padding: 0.5rem 1rem;
  border: 0;
  background: transparent;
  font: 500 0.8125rem/1 var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.segmented button[aria-pressed="true"] {
  background: var(--ink);
  color: var(--paper);
}

.taste textarea {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--ink);
  background: rgb(255 255 255 / 0.45);
  font-size: 1.125rem;
  resize: vertical;
}

.taste__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
  margin-top: 0.75rem;
}

.btn {
  padding: 0.75rem 1.25rem;
  border: 1px solid var(--ink);
  background: transparent;
  font: 500 0.875rem/1 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 120ms var(--ease-out), background-color 150ms var(--ease-out);
}

.btn:active:not(:disabled) {
  transform: translateY(1px);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn--ink {
  background: var(--ink);
  color: var(--paper);
}

.btn--stamp {
  background: var(--stamp);
  border-color: var(--stamp);
  color: var(--paper);
  font-size: 1rem;
  padding: 1rem 1.5rem;
}

.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--muted);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.error,
.banner {
  color: var(--stamp);
  font-family: var(--mono);
  font-size: 0.8125rem;
}

.banner {
  margin: 0;
  padding: 0.75rem clamp(1rem, 4vw, 3rem);
  background: var(--stamp-wash);
  border-bottom: 1px solid var(--stamp);
}

.blend-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--mono);
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* Stamps (passport chips) */
.stamps__list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 1rem 0 0.5rem;
  padding: 0;
  list-style: none;
}

.stamp {
  --tilt: -1.5deg;
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 3.25rem;
  padding: 0.5rem 2rem 0.5rem 0.5rem;
  border: 2px dashed var(--stamp);
  border-radius: 999px;
  background: var(--stamp-wash);
  color: var(--stamp);
  transform: rotate(var(--tilt));
  animation: stamp-in 260ms var(--ease-out) both;
}

.stamps__list li:nth-child(even) .stamp {
  --tilt: 1.25deg;
}

.stamp__img {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  object-fit: cover;
  filter: grayscale(1) contrast(1.1);
  mix-blend-mode: multiply;
}

.stamp__type {
  display: block;
  font-size: 0.625rem;
}

.stamp__name {
  display: block;
  font: 400 1.0625rem/1.1 var(--display);
  color: var(--ink);
}

.stamp__x {
  position: absolute;
  top: 50%;
  right: 0.5rem;
  translate: 0 -50%;
  border: 0;
  background: none;
  color: var(--stamp);
  font-size: 1.125rem;
  line-height: 1;
  cursor: pointer;
}

.stamp--ask {
  flex-wrap: wrap;
  border-radius: 1rem;
  margin: 0;
}

.stamp--ask legend {
  padding: 0 0.25rem;
}

.stamp__option {
  border: 1px solid var(--stamp);
  background: var(--paper);
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}

.stamp--void {
  border-style: solid;
  border-color: var(--rule);
  background: transparent;
  color: var(--muted);
}

.stamp__alt summary {
  cursor: pointer;
  font-size: 0.625rem;
}

.stamps__count {
  color: var(--muted);
}

@keyframes stamp-in {
  from {
    opacity: 0;
    transform: scale(1.3) rotate(-8deg);
  }
  to {
    opacity: 1;
    transform: scale(1) rotate(var(--tilt));
  }
}

/* Boarding pass */
.boarding {
  max-width: 34rem;
  margin: clamp(2rem, 10vh, 6rem) auto;
  padding: 1.5rem 1.75rem;
  border: 1px solid var(--ink);
  background: var(--paper-2);
  box-shadow: 6px 6px 0 var(--ink);
}

.boarding ol {
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
}

.boarding li {
  display: flex;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-top: 1px dashed var(--rule);
}

.boarding li[data-status="running"] {
  color: var(--muted);
}

.boarding li[data-status="running"] .mono {
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

/* Results: editorial column + night map */
.results {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  min-height: calc(100vh - 4.5rem);
}

.results__column {
  padding: clamp(1.25rem, 4vw, 3rem);
  max-width: 44rem;
}

.results__map {
  position: sticky;
  top: 0;
  height: 100vh;
  background: var(--night);
}

.map {
  position: absolute;
  inset: 0;
}

.signal {
  display: inline-block;
  margin: 0 0 1rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid currentColor;
}

.signal[data-level="strong"] {
  color: var(--visa);
}

.signal[data-level="moderate"],
.signal[data-level="weak"] {
  color: var(--stamp);
}

.visa {
  position: relative;
  margin: 0 0 2rem;
  padding: 1.25rem 1.5rem;
  border: 1px solid var(--visa);
  background: var(--visa-wash);
  color: var(--visa);
  overflow: hidden;
}

.visa__head {
  display: flex;
  justify-content: space-between;
}

.visa__hood {
  margin: 0.5rem 0 0.25rem;
  font: 400 clamp(2rem, 5vw, 3.25rem) / 1 var(--display);
  color: var(--ink);
}

.visa__stamp {
  position: absolute;
  right: 1.25rem;
  bottom: 1rem;
  padding: 0.375rem 0.75rem;
  border: 3px double var(--stamp);
  color: var(--stamp);
  font: 500 1rem/1 var(--mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  transform: rotate(-9deg);
  opacity: 0.85;
}

.hoods {
  display: grid;
  gap: 0;
  margin: 0 0 2.5rem;
  padding: 0;
  list-style: none;
}

.hood {
  padding: 1.25rem 0;
  border-top: 1px solid var(--ink);
}

.hood[data-active="true"] .hood__name {
  color: var(--stamp);
}

.hood__name {
  margin: 0.25rem 0;
  font: 400 clamp(1.75rem, 3.5vw, 2.5rem) / 1.05 var(--display);
  transition: color 150ms var(--ease-out);
}

.hood__name button {
  all: unset;
  cursor: pointer;
}

.hood__name button:focus-visible {
  outline: 2px solid var(--stamp);
  outline-offset: 4px;
}

.hood__headline {
  margin: 0;
  font-style: italic;
  font-size: 1.1875rem;
}

.hood__why {
  margin: 0.5rem 0 0;
  color: var(--muted);
}

.hood__facts {
  display: flex;
  gap: 1.5rem;
  margin: 0.75rem 0 0;
}

.hood__facts dt {
  color: var(--muted);
}

.hood__facts dd {
  margin: 0;
  color: var(--ink);
}

.meter {
  display: grid;
  gap: 0.25rem;
  margin-top: 0.75rem;
}

.meter__row {
  display: grid;
  grid-template-columns: 4rem 1fr;
  align-items: center;
  gap: 0.5rem;
}

.meter__bar {
  height: 0.375rem;
  background: var(--stamp);
  transform-origin: left;
}

.section-title {
  margin: 0 0 0.75rem;
  font: 400 1.75rem/1.1 var(--display);
}

.places {
  display: grid;
  gap: 0.75rem;
  margin: 0 0 2.5rem;
  padding: 0;
  list-style: none;
}

.place {
  display: grid;
  grid-template-columns: 4rem 1fr auto;
  align-items: center;
  gap: 0.875rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px dashed var(--rule);
}

.place img,
.place__ph {
  width: 4rem;
  height: 4rem;
  object-fit: cover;
  background: var(--paper-2);
}

.place strong {
  display: block;
  font: 400 1.1875rem/1.15 var(--display);
}

.place__addr {
  display: block;
  color: var(--muted);
  font-size: 0.875rem;
}

.badge {
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--visa);
  color: var(--visa);
  font: 500 0.625rem/1.4 var(--mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}

.plan {
  margin: 0 0 1rem;
  padding: 0;
  list-style: none;
  counter-reset: none;
}

.plan li {
  display: grid;
  grid-template-columns: 6rem 1fr;
  gap: 0.25rem 1rem;
  padding: 0.75rem 0;
  border-top: 1px solid var(--rule);
}

.plan__place {
  font: 400 1.125rem/1.2 var(--display);
}

.plan__note {
  grid-column: 2;
  color: var(--muted);
}

.provenance {
  color: var(--muted);
}

.shared {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0 0 2rem;
  padding: 0;
  list-style: none;
}

.skeleton {
  height: 1.2em;
  width: 70%;
  background: linear-gradient(90deg, var(--paper-2), var(--rule), var(--paper-2));
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

.reveal {
  animation: rise 520ms var(--ease-out) both;
  animation-delay: calc(var(--i, 0) * 90ms);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
}

.colophon {
  padding: 1.5rem clamp(1rem, 4vw, 3rem);
  border-top: 1px solid var(--ink);
  color: var(--muted);
  line-height: 1.7;
}

/* MapLibre controls on night */
.maplibregl-ctrl-attrib {
  background: rgb(14 16 21 / 0.7) !important;
  color: var(--night-ink) !important;
}

.maplibregl-ctrl-attrib a {
  color: var(--night-ink) !important;
}

@media (max-width: 900px) {
  .cover,
  .results {
    grid-template-columns: 1fr;
  }

  .results__map {
    position: relative;
    height: 55vh;
    order: -1;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

**Commit** `git add web/src/styles.css && git commit -m "Add Transplant design tokens: field guide, passport stamps, night map"`

---

### Task 5: Shared types, SSE parser, API client

**Files:** Create `web/src/types.ts`, `web/src/sse.ts`, `web/src/api.ts`; Tests `web/src/sse.test.ts`, `web/src/api.test.ts`.

**Step 1: Failing tests**

`web/src/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.ts";

describe("createSseParser", () => {
  it("emits one event per frame even when frames split across chunks", () => {
    const events: unknown[] = [];
    const feed = createSseParser((e) => events.push(e));

    feed('event: step\ndata: {"type":"step","id":"map"');
    feed(',"label":"Mapping","status":"running"}\n\nevent: done\r\ndata: {"type":"done"}\r\n\r\n');

    expect(events).toEqual([{ type: "step", id: "map", label: "Mapping", status: "running" }, { type: "done" }]);
  });

  it("ignores frames without data", () => {
    const events: unknown[] = [];
    createSseParser((e) => events.push(e))(": keep-alive\n\n");

    expect(events).toEqual([]);
  });
});
```

`web/src/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, resolveTaste, streamTransplant } from "./api.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("resolveTaste posts text and returns chips", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ chips: [{ query: "Aesop" }] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveTaste("Aesop")).toEqual([{ query: "Aesop" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/resolve");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ text: "Aesop" });
  });

  it("maps error bodies to ApiError with a friendly message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "RATE_LIMITED" }, 429)));

    const error = await resolveTaste("x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", message: expect.stringMatching(/hourly limit/) });
  });

  it("streamTransplant reads SSE frames from the response body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('event: hoods\ndata: {"type":"hoods","hoods":[],"cells":[],"signal":{"level":"strong","topScore":0.04,"cells":13}}\n\n'));
        controller.enqueue(enc.encode('event: done\ndata: {"type":"done"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })));
    const events: string[] = [];

    await streamTransplant({ cityId: "nyc", mode: "moving", people: [] }, (e) => events.push(e.type));

    expect(events).toEqual(["hoods", "done"]);
  });
});
```

**Step 2: Run** `npx vitest run --project web` → FAIL.

**Step 3: Implement**

`web/src/types.ts`:

```ts
export type { Place, SharedTag } from "../../server/src/qloo/api.ts";
export type { Chip, ChipOption } from "../../server/src/resolve.ts";
export type { RankedHood, Story } from "../../server/src/story.ts";
export type { MapCell, SignalStrength, TransplantEvent, TransplantInput } from "../../server/src/transplant.ts";

export interface CityInfo {
  id: string;
  name: string;
  beta: boolean;
  bbox: [south: number, west: number, north: number, east: number];
}
```

`web/src/sse.ts`:

```ts
import type { TransplantEvent } from "./types.ts";

export function createSseParser(onEvent: (event: TransplantEvent) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as TransplantEvent);
    }
  };
}
```

`web/src/api.ts`:

```ts
import { createSseParser } from "./sse.ts";
import type { Chip, CityInfo, Place, TransplantEvent, TransplantInput } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FRIENDLY: Record<string, string> = {
  RATE_LIMITED: "You've hit the hourly limit for live lookups. Try again soon.",
  BAD_REQUEST: "That request didn't look right. Check your picks and try again.",
};

const toError = async (res: Response) => {
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  const code = body.code ?? `HTTP_${res.status}`;
  return new ApiError(code, body.message ?? FRIENDLY[code] ?? "Something went wrong. Try again.");
};

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export const fetchCities = () => request<CityInfo[]>("/api/cities");

export const resolveTaste = async (text: string) => (await request<{ chips: Chip[] }>("/api/resolve", post({ text }))).chips;

export const fetchPlaces = async (input: Pick<TransplantInput, "cityId" | "people">, hoodId: string) =>
  (await request<{ places: Place[] }>("/api/places", post({ cityId: input.cityId, people: input.people, hoodId }))).places;

export async function streamTransplant(input: TransplantInput, onEvent: (event: TransplantEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/transplant", { ...post(input), signal });
  if (!res.ok || !res.body) throw await toError(res);
  const feed = createSseParser(onEvent);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    feed(value);
  }
}
```

**Step 4: Run** → PASS (5). Typecheck clean.

**Step 5: Commit** `git add web/src && git commit -m "Add typed API client and SSE parser for the web app"`

---

### Task 6: State machine

**Files:** Create `web/src/state.ts`; Test `web/src/state.test.ts`.

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { initialState, readyToRun, reducer, type State, toInput } from "./state.ts";
import type { Chip } from "./types.ts";

const resolved = (name: string, kind: "entity" | "concept" = "entity", id = name): Chip => ({
  query: name,
  kind,
  status: "resolved",
  selected: { id, name, type: kind === "entity" ? "artist" : "urn:tag:x", kind },
  options: [],
});

const withChips = (s: State, person: number, chips: Chip[]) => reducer(s, { type: "resolveDone", person, chips });

describe("reducer", () => {
  it("merges re-read chips without duplicates", () => {
    let s = withChips(initialState(), 0, [resolved("Khruangbin")]);
    s = withChips(s, 0, [resolved("Khruangbin"), resolved("Fleabag")]);

    expect(s.people[0]!.chips.map((c) => c.query)).toEqual(["Khruangbin", "Fleabag"]);
  });

  it("resolves an ambiguous chip when an option is picked", () => {
    const ambiguous: Chip = {
      query: "Lost",
      kind: "entity",
      status: "ambiguous",
      options: [
        { id: "1", name: "Lost (2004)", type: "tv_show", kind: "entity" },
        { id: "2", name: "Lost Girl", type: "tv_show", kind: "entity" },
      ],
    };
    const s = reducer(withChips(initialState(), 0, [ambiguous]), { type: "pick", person: 0, chip: 0, optionId: "1" });

    expect(s.people[0]!.chips[0]).toMatchObject({ status: "resolved", selected: { name: "Lost (2004)" } });
  });

  it("builds API input from confirmed picks, splitting entities and concepts", () => {
    const s = withChips(initialState(), 0, [resolved("Khruangbin"), resolved("Natural Wine", "concept", "urn:tag:nw"), resolved("Aesop")]);

    expect(toInput(s)).toEqual({
      cityId: "nyc",
      mode: "moving",
      people: [{ label: "You", names: ["Khruangbin", "Natural Wine", "Aesop"], entities: ["Khruangbin", "Aesop"], tags: ["urn:tag:nw"] }],
    });
    expect(readyToRun(s)).toBe(true);
    expect(readyToRun(reducer(s, { type: "blend", on: true }))).toBe(false);
  });

  it("moves to results on hoods, upserts steps, and returns to intake on early errors", () => {
    let s = reducer(initialState(), { type: "runStart" });
    s = reducer(s, { type: "event", event: { type: "step", id: "map", label: "Mapping", status: "running" } });
    s = reducer(s, { type: "event", event: { type: "step", id: "map", label: "Mapping", status: "done" } });
    expect(s.steps).toEqual([{ id: "map", label: "Mapping", status: "done" }]);

    const failed = reducer(s, { type: "event", event: { type: "error", code: "NO_SIGNAL", message: "Not enough signal" } });
    expect(failed).toMatchObject({ stage: "intake", error: { code: "NO_SIGNAL" } });

    const hood = { id: "h1", name: "Greenpoint", lat: 0, lng: 0, score: 0.04, cellCount: 13, byType: [{}], perPerson: [0.04] };
    s = reducer(s, { type: "event", event: { type: "hoods", hoods: [hood], cells: [], signal: { level: "strong", topScore: 0.04, cells: 13 } } });
    expect(s).toMatchObject({ stage: "results", activeHoodId: "h1" });
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement** `web/src/state.ts`:

```ts
import type { Chip, ChipOption, MapCell, Place, RankedHood, SharedTag, SignalStrength, Story, TransplantEvent, TransplantInput } from "./types.ts";

export type Mode = "moving" | "visiting";

export interface Person {
  label: string;
  text: string;
  chips: Chip[];
  resolving: boolean;
  error?: string;
}

export interface Step {
  id: string;
  label: string;
  status: "running" | "done";
}

export interface Results {
  hoods: RankedHood[];
  cells: MapCell[];
  signal: SignalStrength;
  shared?: SharedTag[];
  story?: Story;
  storySource?: "llm" | "template";
}

export interface State {
  cityId: string;
  mode: Mode;
  blend: boolean;
  people: Person[];
  stage: "intake" | "running" | "results";
  steps: Step[];
  results?: Results;
  placesByHood: Record<string, Place[]>;
  activeHoodId?: string;
  error?: { code: string; message: string };
}

export type Action =
  | { type: "city"; cityId: string }
  | { type: "mode"; mode: Mode }
  | { type: "blend"; on: boolean }
  | { type: "text"; person: number; text: string }
  | { type: "resolveStart"; person: number }
  | { type: "resolveDone"; person: number; chips: Chip[] }
  | { type: "resolveFail"; person: number; message: string }
  | { type: "pick"; person: number; chip: number; optionId: string }
  | { type: "removeChip"; person: number; chip: number }
  | { type: "runStart" }
  | { type: "event"; event: TransplantEvent }
  | { type: "runFail"; code: string; message: string }
  | { type: "selectHood"; hoodId: string }
  | { type: "hoodPlaces"; hoodId: string; places: Place[] }
  | { type: "restart" };

export const MIN_PICKS = 3;

const person = (label: string): Person => ({ label, text: "", chips: [], resolving: false });

export const initialState = (cityId = "nyc"): State => ({
  cityId,
  mode: "moving",
  blend: false,
  people: [person("You"), person("Them")],
  stage: "intake",
  steps: [],
  placesByHood: {},
});

const chipKey = (c: Chip) => c.selected?.id ?? c.query.toLowerCase();

const mergeChips = (current: Chip[], incoming: Chip[]) => {
  const seen = new Set(current.map(chipKey));
  return [...current, ...incoming.filter((c) => !seen.has(chipKey(c)) && seen.add(chipKey(c)))];
};

const updatePerson = (s: State, index: number, update: (p: Person) => Person): State => ({
  ...s,
  people: s.people.map((p, i) => (i === index ? update(p) : p)),
});

const cleared = { steps: [], results: undefined, placesByHood: {}, activeHoodId: undefined, error: undefined };

function applyEvent(s: State, e: TransplantEvent): State {
  switch (e.type) {
    case "step": {
      const step = { id: e.id, label: e.label, status: e.status };
      const exists = s.steps.some((x) => x.id === e.id);
      return { ...s, steps: exists ? s.steps.map((x) => (x.id === e.id ? step : x)) : [...s.steps, step] };
    }
    case "hoods":
      return { ...s, stage: "results", results: { hoods: e.hoods, cells: e.cells, signal: e.signal }, activeHoodId: e.hoods[0]?.id };
    case "shared":
      return s.results ? { ...s, results: { ...s.results, shared: e.tags } } : s;
    case "places":
      return { ...s, placesByHood: { ...s.placesByHood, [e.hoodId]: e.places } };
    case "story":
      return s.results ? { ...s, results: { ...s.results, story: e.story, storySource: e.source } } : s;
    case "error":
      return { ...s, stage: s.results ? "results" : "intake", error: { code: e.code, message: e.message } };
    case "done":
      return s;
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "city":
      return { ...s, cityId: a.cityId };
    case "mode":
      return { ...s, mode: a.mode };
    case "blend":
      return { ...s, blend: a.on };
    case "text":
      return updatePerson(s, a.person, (p) => ({ ...p, text: a.text }));
    case "resolveStart":
      return updatePerson(s, a.person, (p) => ({ ...p, resolving: true, error: undefined }));
    case "resolveDone":
      return updatePerson(s, a.person, (p) => ({ ...p, resolving: false, chips: mergeChips(p.chips, a.chips) }));
    case "resolveFail":
      return updatePerson(s, a.person, (p) => ({ ...p, resolving: false, error: a.message }));
    case "pick":
      return updatePerson(s, a.person, (p) => ({
        ...p,
        chips: p.chips.map((c, i) => {
          const selected = i === a.chip ? c.options.find((o) => o.id === a.optionId) : undefined;
          return selected ? { ...c, status: "resolved", selected } : c;
        }),
      }));
    case "removeChip":
      return updatePerson(s, a.person, (p) => ({ ...p, chips: p.chips.filter((_, i) => i !== a.chip) }));
    case "runStart":
      return { ...s, ...cleared, stage: "running" };
    case "event":
      return applyEvent(s, a.event);
    case "runFail":
      return { ...s, stage: s.results ? "results" : "intake", error: { code: a.code, message: a.message } };
    case "selectHood":
      return { ...s, activeHoodId: a.hoodId };
    case "hoodPlaces":
      return { ...s, placesByHood: { ...s.placesByHood, [a.hoodId]: a.places } };
    case "restart":
      return { ...s, ...cleared, stage: "intake" };
  }
}

export const confirmed = (p: Person): ChipOption[] => p.chips.flatMap((c) => (c.status === "resolved" && c.selected ? [c.selected] : []));

export function toInput(s: State): TransplantInput {
  const people = (s.blend ? s.people : s.people.slice(0, 1)).map((p) => {
    const picks = confirmed(p);
    return {
      label: p.label,
      names: picks.map((o) => o.name).slice(0, 15),
      entities: picks.filter((o) => o.kind === "entity").map((o) => o.id).slice(0, 10),
      tags: picks.filter((o) => o.kind === "concept").map((o) => o.id).slice(0, 5),
    };
  });
  return { cityId: s.cityId, mode: s.mode, people };
}

export const readyToRun = (s: State) => toInput(s).people.every((p) => p.entities.length + p.tags.length >= MIN_PICKS);
```

**Step 4: Run** → PASS (4).

**Step 5: Commit** `git add web/src/state* && git commit -m "Add web state machine for intake, run, and results"`

---

### Task 7: Intake — destinations, mode, taste input, passport stamps

**Files:** Create `web/src/components/Intake.tsx`, `web/src/components/ChipBoard.tsx`; Test `web/src/components/ChipBoard.test.tsx`.

**Step 1: Failing test** `web/src/components/ChipBoard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Person } from "../state.ts";
import { ChipBoard } from "./ChipBoard.tsx";

const person: Person = {
  label: "You",
  text: "",
  resolving: false,
  chips: [
    {
      query: "Aesop",
      kind: "entity",
      status: "resolved",
      selected: { id: "b", name: "Aesop", type: "brand", kind: "entity" },
      options: [
        { id: "b", name: "Aesop", type: "brand", kind: "entity" },
        { id: "a", name: "Aesop", type: "author", kind: "entity" },
      ],
    },
    {
      query: "Lost",
      kind: "entity",
      status: "ambiguous",
      options: [
        { id: "1", name: "Lost (2004)", type: "tv_show", kind: "entity" },
        { id: "2", name: "Lost Girl", type: "tv_show", kind: "entity" },
      ],
    },
    { query: "Zzyzx", kind: "entity", status: "missing", options: [] },
  ],
};

describe("ChipBoard", () => {
  it("renders stamps, asks about ambiguous picks, and voids missing ones", async () => {
    const dispatch = vi.fn();
    render(<ChipBoard person={person} index={0} dispatch={dispatch} />);

    expect(screen.getByText("brand")).toBeTruthy();
    expect(screen.getByText(/1\/3 stamps/i)).toBeTruthy();
    expect(screen.getByText(/not in qloo/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /lost \(2004\)/i }));
    expect(dispatch).toHaveBeenCalledWith({ type: "pick", person: 0, chip: 1, optionId: "1" });

    await userEvent.click(screen.getByRole("button", { name: /remove zzyzx/i }));
    expect(dispatch).toHaveBeenCalledWith({ type: "removeChip", person: 0, chip: 2 });
  });

  it("lets a resolved stamp swap to an alternative", async () => {
    const dispatch = vi.fn();
    render(<ChipBoard person={person} index={0} dispatch={dispatch} />);

    await userEvent.click(screen.getByText(/not it\?/i));
    await userEvent.click(screen.getByRole("button", { name: /aesop · author/i }));

    expect(dispatch).toHaveBeenCalledWith({ type: "pick", person: 0, chip: 0, optionId: "a" });
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`web/src/ui.ts` (stagger index for the `.reveal` animation):

```ts
import type { CSSProperties } from "react";

export const stagger = (index: number) => ({ "--i": index }) as CSSProperties;
```

`web/src/components/ChipBoard.tsx`:

```tsx
import type { Dispatch } from "react";
import { type Action, confirmed, MIN_PICKS, type Person } from "../state.ts";
import type { Chip, ChipOption } from "../types.ts";

const typeLabel = (o: ChipOption) => (o.kind === "concept" ? "style" : o.type.replaceAll("_", " "));

function Stamp({ chip, onPick, onRemove }: { chip: Chip; onPick: (id: string) => void; onRemove: () => void }) {
  const remove = (label: string) => (
    <button type="button" className="stamp__x" aria-label={`Remove ${label}`} onClick={onRemove}>
      ×
    </button>
  );

  if (chip.status === "resolved" && chip.selected) {
    const o = chip.selected;
    const alternatives = chip.options.filter((alt) => alt.id !== o.id);
    return (
      <div className="stamp" data-kind={o.kind}>
        {o.image && <img className="stamp__img" src={o.image} alt="" loading="lazy" />}
        <div>
          <span className="stamp__type mono">{typeLabel(o)}</span>
          <strong className="stamp__name">{o.name}</strong>
          {alternatives.length > 0 && (
            <details className="stamp__alt">
              <summary className="mono">not it?</summary>
              {alternatives.map((alt) => (
                <button key={alt.id} type="button" className="stamp__option" onClick={() => onPick(alt.id)}>
                  {alt.name} · {typeLabel(alt)}
                </button>
              ))}
            </details>
          )}
        </div>
        {remove(o.name)}
      </div>
    );
  }

  if (chip.status === "ambiguous") {
    return (
      <fieldset className="stamp stamp--ask">
        <legend className="mono">Which “{chip.query}”?</legend>
        {chip.options.map((o) => (
          <button key={o.id} type="button" className="stamp__option" onClick={() => onPick(o.id)}>
            {o.name} · {typeLabel(o)}
          </button>
        ))}
        {remove(chip.query)}
      </fieldset>
    );
  }

  return (
    <div className="stamp stamp--void">
      <s>{chip.query}</s>
      <span className="mono">not in Qloo</span>
      {remove(chip.query)}
    </div>
  );
}

export function ChipBoard({ person, index, dispatch }: { person: Person; index: number; dispatch: Dispatch<Action> }) {
  if (person.chips.length === 0) return null;
  const count = confirmed(person).length;
  return (
    <section aria-label={`${person.label}'s taste stamps`}>
      <ul className="stamps__list">
        {person.chips.map((chip, i) => (
          <li key={`${chip.query}-${i}`}>
            <Stamp
              chip={chip}
              onPick={(optionId) => dispatch({ type: "pick", person: index, chip: i, optionId })}
              onRemove={() => dispatch({ type: "removeChip", person: index, chip: i })}
            />
          </li>
        ))}
      </ul>
      <p className="stamps__count mono">
        {count}/{MIN_PICKS} stamps {count >= MIN_PICKS ? "· ready to board" : "needed"}
      </p>
    </section>
  );
}
```

`web/src/components/Intake.tsx`:

```tsx
import type { Dispatch } from "react";
import { type Action, readyToRun, type State } from "../state.ts";
import type { CityInfo } from "../types.ts";
import { stagger } from "../ui.ts";
import { ChipBoard } from "./ChipBoard.tsx";

const EXAMPLES = [
  "Khruangbin, Fleabag, natural wine bars and Aesop",
  "Phoebe Bridgers, Severance, vintage clothing and Spirited Away",
  "Metallica, Top Gun: Maverick, Harley-Davidson and steakhouses",
];

interface Props {
  state: State;
  cities: CityInfo[];
  dispatch: Dispatch<Action>;
  onRead: (person: number) => void;
  onRun: () => void;
}

function TasteInput({ state, index, dispatch, onRead }: { state: State; index: number; dispatch: Dispatch<Action>; onRead: (person: number) => void }) {
  const person = state.people[index]!;
  return (
    <div className="ticket__section">
      <form
        className="taste"
        onSubmit={(e) => {
          e.preventDefault();
          onRead(index);
        }}
      >
        <label className="eyebrow" htmlFor={`taste-${index}`}>
          {index === 0 ? "What do you love?" : "What do they love?"}
        </label>
        <textarea
          id={`taste-${index}`}
          rows={3}
          maxLength={600}
          value={person.text}
          placeholder="Artists, shows, films, brands, the kind of places you seek out…"
          onChange={(e) => dispatch({ type: "text", person: index, text: e.target.value })}
        />
        <div className="taste__row">
          <button type="submit" className="btn btn--ink" disabled={!person.text.trim() || person.resolving}>
            {person.resolving ? "Reading your taste…" : "Read my taste"}
          </button>
          {index === 0 &&
            EXAMPLES.slice(0, 2).map((example) => (
              <button key={example} type="button" className="link" onClick={() => dispatch({ type: "text", person: 0, text: example })}>
                e.g. {example.split(",")[0]}…
              </button>
            ))}
        </div>
        {person.error && (
          <p role="alert" className="error">
            {person.error}
          </p>
        )}
      </form>
      <ChipBoard person={person} index={index} dispatch={dispatch} />
    </div>
  );
}

export function Intake({ state, cities, dispatch, onRead, onRun }: Props) {
  const ready = readyToRun(state);
  return (
    <main className="cover">
      <section className="reveal">
        <p className="eyebrow">Vol. 1 · {cities.length || 12} cities · powered by Qloo's taste graph</p>
        <h2 className="cover__headline">Find the neighborhood that already loves what you love.</h2>
        <p className="cover__dek">
          Tell us your artists, shows, brands and haunts. We map where people with your exact taste cluster in a new city — then hand you the
          spots and your first week.
        </p>
      </section>

      <section className="ticket reveal" style={stagger(1)}>
        <div className="ticket__section">
          <p className="eyebrow">Destination</p>
          <ul className="destinations">
            {cities.map((c) => (
              <li key={c.id}>
                <button type="button" className="destination" aria-pressed={c.id === state.cityId} onClick={() => dispatch({ type: "city", cityId: c.id })}>
                  {c.name}
                  {c.beta && <span className="destination__beta">beta</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="segmented" role="group" aria-label="Trip type">
            {(["moving", "visiting"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={state.mode === mode} onClick={() => dispatch({ type: "mode", mode })}>
                {mode === "moving" ? "Moving there" : "Visiting"}
              </button>
            ))}
          </div>
        </div>

        <TasteInput state={state} index={0} dispatch={dispatch} onRead={onRead} />

        <label className="blend-toggle">
          <input type="checkbox" checked={state.blend} onChange={(e) => dispatch({ type: "blend", on: e.target.checked })} />
          Moving with someone? Blend your tastes
        </label>
        {state.blend && <TasteInput state={state} index={1} dispatch={dispatch} onRead={onRead} />}

        <div>
          <button type="button" className="btn btn--stamp" disabled={!ready} onClick={onRun}>
            Transplant my taste →
          </button>
          {!ready && <p className="stamps__count mono">Confirm at least 3 stamps{state.blend ? " each" : ""} to board.</p>}
        </div>
      </section>
    </main>
  );
}
```

**Step 4: Run** → PASS (2). Typecheck clean.

**Step 5: Commit** `git add web/src/components && git commit -m "Add intake ticket with destinations, mode, and passport-stamp chips"`

---

### Task 8: Boarding pass and results features

**Files:** Create `web/src/components/Progress.tsx`, `web/src/components/Results.tsx`, `web/src/map-data.ts`; Tests `web/src/components/Results.test.tsx`, `web/src/map-data.test.ts`.

**Step 1: Failing tests**

`web/src/map-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cellsToGeoJSON, hoodsToGeoJSON } from "./map-data.ts";

describe("map-data", () => {
  it("normalizes positive lift into 0..1 heat weights and drops non-positive cells", () => {
    const fc = cellsToGeoJSON([
      { lat: 1, lng: 2, lift: 0.04 },
      { lat: 3, lng: 4, lift: 0.02 },
      { lat: 5, lng: 6, lift: -0.01 },
    ]);

    expect(fc.features.map((f) => [f.geometry.coordinates, f.properties.w])).toEqual([
      [[2, 1], 1],
      [[4, 3], 0.5],
    ]);
  });

  it("numbers hoods and flags the active one", () => {
    const hood = { id: "h1", name: "Greenpoint", lat: 40.73, lng: -73.95, score: 0.04, cellCount: 13, byType: [{}], perPerson: [0.04] };

    expect(hoodsToGeoJSON([hood], "h1").features[0]!.properties).toEqual({ id: "h1", label: "1 · Greenpoint", active: true });
  });
});
```

`web/src/components/Results.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { initialState, type State } from "../state.ts";
import type { CityInfo, Place } from "../types.ts";
import { Results } from "./Results.tsx";

vi.mock("./MapView.tsx", () => ({ MapView: () => <div data-testid="map" /> }));

const city: CityInfo = { id: "nyc", name: "New York City", beta: false, bbox: [40.49, -74.26, 40.92, -73.7] };
const hood = (id: string, name: string) => ({ id, name, lat: 40.7, lng: -73.9, score: 0.037, cellCount: 13, byType: [{ artist: 0.9 }], perPerson: [0.037] });
const place = (id: string, name: string): Place =>
  ({ id, name, genre: "urn:tag:genre:place:comic_book_store", categories: [], lat: 0, lng: 0, affinity: 0.85, closed: false }) as Place;

const state: State = {
  ...initialState(),
  stage: "results",
  activeHoodId: "h1",
  results: {
    hoods: [hood("h1", "Greenpoint"), hood("h2", "Williamsburg")],
    cells: [],
    signal: { level: "strong", topScore: 0.037, cells: 13 },
    story: {
      hoods: [{ hoodId: "h1", headline: "Your crate-digging corner", why: "People who love Khruangbin over-index here." }],
      plan: [{ when: "Day 1", placeId: "p1", note: "Zines at Desert Island" }],
    },
    storySource: "llm",
  },
  placesByHood: { h1: [place("p1", "Desert Island")] },
};

describe("Results", () => {
  it("renders the visa, features, spots, plan, and provenance", () => {
    render(<Results state={state} city={city} onSelectHood={vi.fn()} onRestart={vi.fn()} />);

    expect(screen.getByLabelText(/taste visa/i).textContent).toMatch(/Greenpoint/);
    expect(screen.getByRole("heading", { name: "Williamsburg" })).toBeTruthy();
    expect(screen.getByText("Your crate-digging corner")).toBeTruthy();
    expect(screen.getByText("Comic book store")).toBeTruthy();
    expect(screen.getByText("Zines at Desert Island")).toBeTruthy();
    expect(screen.getByText(/written by ai from qloo evidence/i)).toBeTruthy();
    expect(screen.getByText(/signal strong/i)).toBeTruthy();
  });

  it("selects another hood", async () => {
    const onSelectHood = vi.fn();
    render(<Results state={state} city={city} onSelectHood={onSelectHood} onRestart={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /williamsburg/i }));

    expect(onSelectHood).toHaveBeenCalledWith("h2");
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`web/src/map-data.ts`:

```ts
import type { MapCell, RankedHood } from "./types.ts";

type Point<P> = { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: P };
type Collection<P> = { type: "FeatureCollection"; features: Point<P>[] };

const point = <P>(lng: number, lat: number, properties: P): Point<P> => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties });

export function cellsToGeoJSON(cells: MapCell[]): Collection<{ w: number }> {
  const positive = cells.filter((c) => c.lift > 0);
  const max = Math.max(...positive.map((c) => c.lift), Number.EPSILON);
  return { type: "FeatureCollection", features: positive.map((c) => point(c.lng, c.lat, { w: Number((c.lift / max).toFixed(3)) })) };
}

export function hoodsToGeoJSON(hoods: RankedHood[], activeId?: string): Collection<{ id: string; label: string; active: boolean }> {
  return {
    type: "FeatureCollection",
    features: hoods.map((h, i) => point(h.lng, h.lat, { id: h.id, label: `${i + 1} · ${h.name}`, active: h.id === activeId })),
  };
}
```

`web/src/components/Progress.tsx`:

```tsx
import type { Step } from "../state.ts";

export function Progress({ steps, cityName }: { steps: Step[]; cityName: string }) {
  return (
    <main className="boarding" aria-live="polite">
      <p className="eyebrow">Now boarding · {cityName}</p>
      <ol>
        {steps.length === 0 && (
          <li data-status="running">
            <span className="mono">…</span>Checking in your taste
          </li>
        )}
        {steps.map((s) => (
          <li key={s.id} data-status={s.status}>
            <span className="mono">{s.status === "done" ? "✓" : "…"}</span>
            {s.label}
          </li>
        ))}
      </ol>
    </main>
  );
}
```

`web/src/components/Results.tsx`:

```tsx
import { placeLabel } from "../../../server/src/places.ts";
import { type State, toInput } from "../state.ts";
import type { CityInfo, Place, RankedHood } from "../types.ts";
import { stagger } from "../ui.ts";
import { MapView } from "./MapView.tsx";

interface Props {
  state: State;
  city: CityInfo;
  onSelectHood: (hoodId: string) => void;
  onRestart: () => void;
}

const lift = (score: number) => `+${(score * 100).toFixed(1)}`;

function Meter({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values.map(Math.abs), Number.EPSILON);
  return (
    <div className="meter mono" aria-label="Fit for each person">
      {values.map((v, i) => (
        <div className="meter__row" key={labels[i]}>
          <span>{labels[i]}</span>
          <span className="meter__bar" style={{ transform: `scaleX(${Math.max(v, 0) / max})` }} />
        </div>
      ))}
    </div>
  );
}

function Places({ places, hoodName }: { places: Place[] | undefined; hoodName: string }) {
  return (
    <section className="reveal" style={stagger(3)}>
      <h2 className="section-title">Your spots in {hoodName}</h2>
      {!places && <p className="mono">Finding spots in {hoodName}…</p>}
      {places?.length === 0 && <p>No curated spots here yet.</p>}
      <ul className="places">
        {places?.map((p) => (
          <li key={p.id} className="place">
            {p.image ? <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="place__ph" />}
            <div>
              <span className="mono">{placeLabel(p)}</span>
              <strong>{p.name}</strong>
              {p.address && <span className="place__addr">{p.address}</span>}
            </div>
            <span className="badge">Qloo match {Math.round(p.affinity * 100)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Results({ state, city, onSelectHood, onRestart }: Props) {
  const results = state.results!;
  const [top] = results.hoods as [RankedHood, ...RankedHood[]];
  const active = results.hoods.find((h) => h.id === state.activeHoodId) ?? top;
  const labels = toInput(state).people.map((p) => p.label);
  const topPlaces = state.placesByHood[top.id] ?? [];
  const byId = new Map(topPlaces.map((p) => [p.id, p]));
  const { story, storySource } = results;

  return (
    <main className="results">
      <div className="results__column">
        <p className="signal mono" data-level={results.signal.level}>
          Signal {results.signal.level}
          {city.beta ? " · beta city" : ""}
        </p>

        <aside className="visa reveal" aria-label="Your taste visa">
          <div className="visa__head mono">
            <span>Taste visa</span>
            <span>{city.name}</span>
          </div>
          <p className="visa__hood">{top.name}</p>
          <p className="mono">
            {state.mode === "moving" ? "Residency" : "Visit"} · holder{labels.length > 1 ? "s" : ""}: {labels.join(" & ")}
          </p>
          <div className="visa__stamp" aria-hidden>
            Admitted
          </div>
        </aside>

        {results.shared && results.shared.length > 0 && (
          <section>
            <p className="eyebrow">What you both love</p>
            <ul className="shared">
              {results.shared.map((t) => (
                <li key={t.id} className="badge">
                  {t.name}
                </li>
              ))}
            </ul>
          </section>
        )}

        <ol className="hoods">
          {results.hoods.map((hood, i) => {
            const copy = story?.hoods.find((h) => h.hoodId === hood.id);
            return (
              <li key={hood.id} className="reveal" style={stagger(i + 1)}>
                <article className="hood" data-active={hood.id === active.id}>
                  <span className="mono">No. {i + 1}</span>
                  <h3 className="hood__name">
                    <button type="button" aria-pressed={hood.id === active.id} onClick={() => onSelectHood(hood.id)}>
                      {hood.name}
                    </button>
                  </h3>
                  {copy ? <p className="hood__headline">{copy.headline}</p> : <p className="hood__headline skeleton" aria-hidden />}
                  {copy && <p className="hood__why">{copy.why}</p>}
                  <dl className="hood__facts mono">
                    <div>
                      <dt>Taste lift</dt>
                      <dd>{lift(hood.score)}</dd>
                    </div>
                    <div>
                      <dt>Evidence</dt>
                      <dd>{hood.cellCount} Qloo cells</dd>
                    </div>
                  </dl>
                  {hood.perPerson.length > 1 && <Meter values={hood.perPerson} labels={labels} />}
                </article>
              </li>
            );
          })}
        </ol>

        <Places places={state.placesByHood[active.id]} hoodName={active.name} />

        {story && story.plan.length > 0 && (
          <section className="reveal" style={stagger(4)}>
            <h2 className="section-title">{state.mode === "moving" ? `Your first week in ${top.name}` : `Your days in ${top.name}`}</h2>
            <ol className="plan">
              {story.plan.map((item) => {
                const place = byId.get(item.placeId);
                return place ? (
                  <li key={`${item.when}-${item.placeId}`}>
                    <span className="mono">{item.when}</span>
                    <span className="plan__place">{place.name}</span>
                    <span className="plan__note">{item.note}</span>
                  </li>
                ) : null;
              })}
            </ol>
            <p className="provenance mono">{storySource === "llm" ? "Written by AI from Qloo evidence" : "Summarized from Qloo evidence"}</p>
          </section>
        )}

        <button type="button" className="btn" onClick={onRestart}>
          ← Try another taste or city
        </button>
      </div>

      <div className="results__map">
        <MapView city={city} cells={results.cells} hoods={results.hoods} activeHoodId={active.id} onSelectHood={onSelectHood} />
      </div>
    </main>
  );
}
```

`MapView.tsx` is created in Task 9; until then the test mocks it. Create a stub now so typecheck passes:

```tsx
import type { CityInfo, MapCell, RankedHood } from "../types.ts";

export interface MapViewProps {
  city: CityInfo;
  cells: MapCell[];
  hoods: RankedHood[];
  activeHoodId: string;
  onSelectHood: (hoodId: string) => void;
}

export function MapView(_props: MapViewProps) {
  return <div className="map" />;
}
```

**Step 4: Run** → PASS (4). Typecheck clean.

**Step 5: Commit** `git add web/src && git commit -m "Add boarding pass, taste visa, hood features, spots, and plan"`

---

### Task 9: Night map and App wiring

**Files:** Replace `web/src/components/MapView.tsx`, `web/src/App.tsx`; Replace test `web/src/App.test.tsx`.

**Step 1: Failing test** — replace `web/src/App.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chip, TransplantEvent } from "./types.ts";

const api = vi.hoisted(() => ({
  fetchCities: vi.fn(),
  resolveTaste: vi.fn(),
  streamTransplant: vi.fn(),
  fetchPlaces: vi.fn(),
}));
vi.mock("./api.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock("./components/MapView.tsx", () => ({ MapView: () => <div data-testid="map" /> }));

const { App } = await import("./App.tsx");

const chip = (name: string, type: string): Chip => ({
  query: name,
  kind: "entity",
  status: "resolved",
  selected: { id: name, name, type, kind: "entity" },
  options: [],
});

const events: TransplantEvent[] = [
  { type: "step", id: "map", label: "Mapping where your taste lives in New York City", status: "running" },
  {
    type: "hoods",
    hoods: [{ id: "h1", name: "Greenpoint", lat: 40.73, lng: -73.95, score: 0.037, cellCount: 13, byType: [{}], perPerson: [0.037] }],
    cells: [],
    signal: { level: "strong", topScore: 0.037, cells: 13 },
  },
  { type: "places", hoodId: "h1", places: [{ id: "p1", name: "Desert Island", genre: "", categories: ["Book store"], lat: 0, lng: 0, affinity: 0.85, closed: false }] },
  { type: "story", source: "llm", story: { hoods: [{ hoodId: "h1", headline: "Crate-digger's corner", why: "w" }], plan: [{ when: "Day 1", placeId: "p1", note: "Zines" }] } },
  { type: "done" },
];

beforeEach(() => {
  api.fetchCities.mockResolvedValue([
    { id: "nyc", name: "New York City", beta: false, bbox: [40.49, -74.26, 40.92, -73.7] },
    { id: "tokyo", name: "Tokyo", beta: true, bbox: [35.53, 139.56, 35.82, 139.92] },
  ]);
  api.resolveTaste.mockResolvedValue([chip("Khruangbin", "artist"), chip("Fleabag", "tv_show"), chip("Aesop", "brand")]);
  api.streamTransplant.mockImplementation(async (_input: unknown, onEvent: (e: TransplantEvent) => void) => {
    for (const e of events) onEvent(e);
  });
});

describe("App", () => {
  it("goes from taste text to stamped picks to a mapped result", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /tokyo\s*beta/i })).toBeTruthy();

    const run = screen.getByRole("button", { name: /transplant my taste/i });
    expect((run as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/what do you love/i), "Khruangbin, Fleabag, Aesop");
    await userEvent.click(screen.getByRole("button", { name: /read my taste/i }));
    expect(await screen.findByText(/3\/3 stamps/i)).toBeTruthy();
    expect(api.resolveTaste).toHaveBeenCalledWith("Khruangbin, Fleabag, Aesop");

    await userEvent.click(run);

    const visa = await screen.findByLabelText(/taste visa/i);
    expect(within(visa).getByText("Greenpoint")).toBeTruthy();
    expect(screen.getByText("Crate-digger's corner")).toBeTruthy();
    expect(screen.getAllByText("Desert Island").length).toBeGreaterThan(0);
    expect(api.streamTransplant.mock.calls[0]![0]).toMatchObject({ cityId: "nyc", people: [{ entities: ["Khruangbin", "Fleabag", "Aesop"] }] });
  });

  it("shows a friendly error and returns to intake when the run fails early", async () => {
    api.streamTransplant.mockImplementation(async (_input: unknown, onEvent: (e: TransplantEvent) => void) => {
      onEvent({ type: "error", code: "NO_SIGNAL", message: "Not enough Qloo taste signal in New York City." });
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText(/what do you love/i), "a, b, c");
    await userEvent.click(screen.getByRole("button", { name: /read my taste/i }));
    await userEvent.click(await screen.findByRole("button", { name: /transplant my taste/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/not enough qloo taste signal/i);
    expect(screen.getByLabelText(/what do you love/i)).toBeTruthy();
  });
});
```

**Step 2: Run** → FAIL (placeholder App).

**Step 3: Implement**

`web/src/components/MapView.tsx`:

```tsx
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { cellsToGeoJSON, hoodsToGeoJSON } from "../map-data.ts";
import type { CityInfo, MapCell, RankedHood } from "../types.ts";

export interface MapViewProps {
  city: CityInfo;
  cells: MapCell[];
  hoods: RankedHood[];
  activeHoodId: string;
  onSelectHood: (hoodId: string) => void;
}

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const EMPTY = { type: "FeatureCollection" as const, features: [] };
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function MapView({ city, cells, hoods, activeHoodId, onSelectHood }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const select = useRef(onSelectHood);
  const [ready, setReady] = useState(false);
  select.current = onSelectHood;

  useEffect(() => {
    const [south, west, north, east] = city.bbox;
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      bounds: [
        [west, south],
        [east, north],
      ],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.on("load", () => {
      map.addSource("taste", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "taste-heat",
        type: "heatmap",
        source: "taste",
        paint: {
          "heatmap-weight": ["get", "w"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.9, 14, 2],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 14, 12, 34, 15, 60],
          "heatmap-opacity": 0.85,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(194,65,12,0)",
            0.25,
            "rgba(194,65,12,0.45)",
            0.55,
            "#ea580c",
            0.8,
            "#f59e0b",
            1,
            "#fde68a",
          ],
        },
      });
      map.addSource("hoods", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "hood-dots",
        type: "circle",
        source: "hoods",
        paint: {
          "circle-radius": ["case", ["get", "active"], 9, 6],
          "circle-color": ["case", ["get", "active"], "#fde68a", "#e9e4da"],
          "circle-stroke-color": "#0e1015",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "hood-labels",
        type: "symbol",
        source: "hoods",
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-offset": [0, 1.3], "text-anchor": "top" },
        paint: { "text-color": "#e9e4da", "text-halo-color": "#0e1015", "text-halo-width": 1.5 },
      });
      map.on("click", "hood-dots", (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") select.current(id);
      });
      map.on("mouseenter", "hood-dots", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "hood-dots", () => {
        map.getCanvas().style.cursor = "";
      });
      setReady(true);
    });
    return () => {
      setReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [city]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("taste") as GeoJSONSource).setData(cellsToGeoJSON(cells));
    (map.getSource("hoods") as GeoJSONSource).setData(hoodsToGeoJSON(hoods, activeHoodId));
  }, [ready, cells, hoods, activeHoodId]);

  useEffect(() => {
    const hood = hoods.find((h) => h.id === activeHoodId);
    if (ready && hood) mapRef.current?.flyTo({ center: [hood.lng, hood.lat], zoom: 12.5, duration: reducedMotion() ? 0 : 1400 });
  }, [ready, hoods, activeHoodId]);

  return <div ref={container} className="map" role="img" aria-label={`Taste heatmap of ${city.name}`} />;
}
```

`web/src/App.tsx`:

```tsx
import { useEffect, useReducer, useState } from "react";
import { ApiError, fetchCities, fetchPlaces, resolveTaste, streamTransplant } from "./api.ts";
import { Intake } from "./components/Intake.tsx";
import { Progress } from "./components/Progress.tsx";
import { Results } from "./components/Results.tsx";
import { initialState, reducer, toInput } from "./state.ts";
import type { CityInfo } from "./types.ts";

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());
  const [cities, setCities] = useState<CityInfo[]>([]);
  const city = cities.find((c) => c.id === state.cityId);

  useEffect(() => {
    fetchCities()
      .then(setCities)
      .catch(() => setCities([]));
  }, []);

  const read = async (person: number) => {
    dispatch({ type: "resolveStart", person });
    try {
      dispatch({ type: "resolveDone", person, chips: await resolveTaste(state.people[person]!.text) });
    } catch (error) {
      dispatch({ type: "resolveFail", person, message: message(error, "Couldn't read that. Try again.") });
    }
  };

  const run = async () => {
    dispatch({ type: "runStart" });
    try {
      await streamTransplant(toInput(state), (event) => dispatch({ type: "event", event }));
    } catch (error) {
      dispatch({ type: "runFail", code: error instanceof ApiError ? error.code : "NETWORK", message: message(error, "Connection lost. Try again.") });
    }
  };

  const selectHood = async (hoodId: string) => {
    dispatch({ type: "selectHood", hoodId });
    if (state.placesByHood[hoodId]) return;
    const places = await fetchPlaces(toInput(state), hoodId).catch(() => []);
    dispatch({ type: "hoodPlaces", hoodId, places });
  };

  const restart = () => dispatch({ type: "restart" });

  return (
    <div className="app" data-stage={state.stage}>
      <header className="masthead">
        <h1 className="masthead__title">
          <button type="button" onClick={restart}>
            Transplant
          </button>
        </h1>
        <span className="masthead__issue mono">A field guide to where your taste lives</span>
      </header>

      {state.error && (
        <p role="alert" className="banner">
          {state.error.message}
        </p>
      )}

      {state.stage === "intake" && <Intake state={state} cities={cities} dispatch={dispatch} onRead={read} onRun={run} />}
      {state.stage === "running" && <Progress steps={state.steps} cityName={city?.name ?? ""} />}
      {state.stage === "results" && city && state.results && <Results state={state} city={city} onSelectHood={selectHood} onRestart={restart} />}

      <footer className="colophon mono">
        Taste data: Qloo. Results are aggregate cultural affinities, not predictions about any person. Neighborhoods © OpenStreetMap
        contributors. Map tiles: OpenFreeMap.
      </footer>
    </div>
  );
}
```

**Step 4: Run** `npx vitest run && npm run typecheck && npm run build:web` → all PASS; build succeeds.

**Step 5: Commit** `git add web/src && git commit -m "Wire App flow and MapLibre night map with taste heat"`

---

### Task 10: Browser QA (real servers, ~4–8 Qloo calls)

1. Start the API (`npm run dev`, background) and the web app (`npm run web`, background). Open a browser preview at `http://localhost:5173`.
2. Walk the golden path: NYC → "e.g. Khruangbin…" example → Read my taste → 4 stamps → Transplant. Expect boarding pass → split screen, amber heat over north Brooklyn, Greenpoint visa, three features, spots, first-week plan naming places.
3. Click hood #2 in the list and on the map: list highlight, map flies, spots load via `/api/places`.
4. Blend: add "Metallica, Top Gun: Maverick, Harley-Davidson" as person 2 → meters per hood, "What you both love" tags.
5. Edge cases: ambiguous chip ("Lost"), "not it?" swap on Aesop, a beta city (Tokyo) label, 390 px mobile width (map above column), keyboard-only path (Tab through destinations, stamps, Run), reduced motion.
6. Use the `browser-ui-qa` skill or `agent-browser` MCP to capture screenshots and console errors; fix any errors found (write a failing test first when it is logic).
7. Record findings and screenshots list in the design doc; commit fixes.

---

## Out of scope for M3 (tracked)

- Shareable visa image / link → M4.
- Agent refinement chat, warmed demo profiles, quota banner wording → M4.
- Serving `dist/web` from Hono, Docker, Fly.io → M5.
