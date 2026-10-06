# Transplant — Design

Date: 2026-10-04
Event: Qloo Agentic Hackathon (deadline 2026-10-30 23:45 EDT)

## Pitch

**Transplant: your taste, relocated.** Find the neighborhood that already loves
what you love. Tell it a handful of things you love — artists, shows, brands,
places — pick a city, and Transplant maps where your taste lives there, finds
the local spots that match it, and plans your first week (Moving) or your days
(Visiting). Moving with someone? Blend both tastes and find the neighborhood
that satisfies you both.

Why it only works with Qloo: an LLM alone returns tourist-guide neighborhoods.
Qloo's cross-domain taste graph plus geographic heatmaps tell us which blocks
over-index on *your specific* combination of music, TV, brands and places.

## Judging alignment

| Criterion | Evidence in product |
| --- | --- |
| Technological implementation | Search + disambiguation, multi-signal heatmaps with popularity-adjusted lift, place insights filtered by locality, analysis/compare for blends, agent tool calls with provenance. |
| Design | Complete flow: chips → map → spots → plan → refine. Two modes, blend mode, demo profiles. |
| Potential impact | Relocators, students, remote workers, travelers choosing where to live/stay. |
| Quality of idea | Cultural geography: "where does my taste live" is unanswerable without a taste graph. |

## User flow

1. **City + mode.** Moving or Visiting. 12 curated cities (NYC, LA, London,
   Paris, Berlin, Lisbon, Tokyo, Seoul, Mexico City, Austin, Toronto,
   Barcelona); any other city works with a "beta" label.
2. **Taste input.** Free text. The agent extracts candidate entities and
   resolves each via Qloo `/search` into a chip (image, name, type). Ambiguous
   matches show 2–3 typed alternatives. Minimum 3 confirmed chips.
3. **Blend (optional).** Second person's chips. Shared ground vs. yours vs.
   theirs from `/v2/analysis/compare`.
4. **Results.**
   - Neighborhood map: heatmap of taste lift, top 3 neighborhoods ranked, each
     with a "why" grounded in per-category affinity and returned evidence.
   - Blend: neighborhoods ranked by `min(liftA, liftB)` plus a shared-tag bonus.
   - Your spots: `urn:entity:place` insights with the user's signals, filtered
     to the chosen neighborhood.
   - Mode section: first-week plan (Moving) or day itinerary (Visiting), built
     only from returned places.
5. **Refine.** Chat ("quieter", "more nightlife"); the agent re-runs only the
   affected tools.

Provenance: every Qloo-derived claim carries a "Qloo signal" badge; LLM prose is
visually distinct. Copy states results are aggregate affinities, not predictions
about any individual. No accounts; only cultural entity names are sent to Qloo.

Out of scope: accounts, playlist imports, saved trips, booking links.

## Verified API facts (probed 2026-10-04)

- REST at `https://hackathon.api.qloo.com`, header `X-Api-Key`. GET only.
- Limits: **5 req/s**, **10,000 req/month** (resets ~2026-11-03). `take` ≤ 50.
- `/search?query=&types=` resolves entities; untyped search can pick the wrong
  entity ("Aesop" → author), so confirmation is mandatory.
- `filter.type=urn:heatmap` with multiple `signal.interests.entities` and
  `filter.location.query=<city>` returns 100–600 geohash-6 cells with
  `affinity`, `affinity_rank`, `popularity`, and per-type
  `entity_<type>_affinity`.
- Raw `affinity` correlates 0.95–0.98 with `popularity`. Two opposite profiles
  share the same top cell. After regressing out popularity, residuals correlate
  0.19 — the taste signal is real but must be extracted.
- `filter.type=urn:entity:place` + signals + `filter.location.query=<hood, city>`
  returns taste-consistent places with addresses and tags.
- `/v2/analysis/compare` with `a.` / `b.signal.interests.entities` returns
  shared tags with scores.
- `/search?types=urn:entity:locality` returns neighborhoods with ancestors.

- Concepts ("natural wine bars") resolve via `/v2/tags` and work as
  `signal.interests.tags` in heatmaps.
- Places must be filtered with `filter.location=POINT(lng lat)` +
  `filter.location.radius`; `filter.location.query="<hood>, <city>"` does not
  constrain results. Raw results include noise (e.g. a wastewater plant), so
  places are curated by `primary_genre`.

## M1 go/no-go result (2026-10-05)

Fixtures: two profiles — indie (Khruangbin, Fleabag, Aesop) vs. mainstream
(Metallica, Top Gun: Maverick, Harley-Davidson) — in Lisbon (270 cells), NYC
(790–1182 cells) and London (1509 cells). 12 Qloo calls; 9,919 left this month.

Chosen scoring (via `npm run lift-report`):
- `tasteLift` on `affinity`, popularity floor 0.3. (`affinity_rank` was worse:
  it re-surfaced central tourist hoods such as Soho and Covent Garden.)
- `scoreHoods` kernel: every cell within 1.5 km of a hood center, popularity-
  weighted, shrinkage prior 2, min 4 cells, de-duplicated by name. Nearest-
  point assignment was rejected: top hoods rested on a single cell.
- Per-city `hoodKinds` filter drops tiny OSM estates (London neighbourhoods,
  Lisbon "Quinta/Bairro" nodes).

| City | Indie top 3 | Mainstream top 3 |
| --- | --- | --- |
| NYC | Greenpoint, Williamsburg, Red Hook | Bath Beach, Bensonhurst, New Utrecht |
| London | Upper Clapton, South Tottenham, West Hackney | Hounslow West, Upton Park, West Drayton |
| Lisbon | Algés, Campo Grande, Célula E | Olivais, Penha de França, Santa Maria Maior |

Decision: **GO.** Top-3 overlap is 0 in every city and NYC/London results are
recognisable with 9–16 cells of evidence each. Lisbon is weaker (sparser data,
lift ≤0.05) — the product must expose signal strength (cell count, lift
spread) and the demo should lead with dense-data cities.

## M2 live smoke (2026-10-05)

Input text: "I love Khruangbin, Fleabag, natural wine bars and Aesop" → NYC, Moving.
- `/api/resolve` (2.5 s): 4/4 chips resolved; Aesop → brand; "natural wine bars"
  → `urn:tag:resy:collection:place:natural_wine`.
- `/api/transplant` (3.8 s cold, 2.3 s warm): Greenpoint (0.037, 13 cells),
  Williamsburg, Red Hook; signal strong. Places: Desert Island, Patisserie
  Tomoko, Beacon's Closet, The End Brooklyn, Land to Sea, Tea Bar, Artists &
  Fleas, HEATONIST. Story from Gemini flash-lite.
- Warm rerun spent 0 Qloo calls (cache). Quota after smoke: 9,905.
- Follow-up: story copy is generic ("Grab a morning coffee") and doesn't name
  places; tighten the prompt (name the place, cite the strongest taste) in M3.

## 12-city validation (2026-10-06)

Same two profiles, `npm run lift-report`, 26 Qloo calls (quota 9,877 left).
Scoring additions: hoods closer than 1 km to a better-ranked hood are dropped
(top 3 = distinct areas); non-Latin OSM names without `name:en` are excluded.
Tokyo's "Tokyo" locality covers the islands (geohash-5, 104 cells), so it uses
`locateByBbox` (WKT polygon → geohash-6, 385 cells). Resolution varies by city
(geohash 6 in NYC, 7 in Paris/Seoul), which the km-based kernel absorbs.

| City | Kinds | Indie top 3 | Mainstream top 3 | Verdict |
| --- | --- | --- | --- | --- |
| NYC | sub+qtr+nbhd | Greenpoint, Williamsburg, Red Hook | Bath Beach, New Utrecht, Dyker Heights | strong |
| London | sub+qtr | Upper Clapton, South Tottenham, Tottenham Hale | Hounslow West, Upton Park, West Drayton | strong |
| Los Angeles | sub+qtr+nbhd | Elysian Valley, Mount Washington, Glassell Park | Little Italy, San Pedro Arts District, Raymer | strong |
| Austin | sub+qtr+nbhd | Chestnut, Allandale, Cherrywood | Walnut Ridge, MetCenter, North Lamar | strong |
| Toronto | sub+qtr+nbhd | Algonquin Island, Bloordale Village, Sunnyside | Downsview, Maple Leaf, Caledonia-Fairbank | strong |
| Berlin | qtr (Kieze) | Donaukiez, Weiße Siedlung, Kungerkiez | Grüne Aue, Witzleben, Fasanenkiez | good |
| Paris | sub+qtr | Quatre Chemins, 19e, Église | Grenelle, Passy, Gros-Caillou | good |
| Barcelona | qtr | el Coll, Can Baró, Poblenou | Marina del Prat Vermell, Montjuïc, Torre Baró | fair (lift ≤0.03) |
| Mexico City | sub+qtr | San Simón Tolnáhuac, Churubusco, Xoco | Cuautepec, Zapotitlán, Condesa | fair |
| Lisbon | sub+qtr+admin8 | Algés, Campo Grande, Célula E | Olivais, Penha de França, Santa Maria Maior | beta |
| Tokyo | sub+qtr, bbox | Shiomi, Shitaya, Kizuki | Umeda, Kaigan, Chūōhonchō | beta |
| Seoul | sub+qtr | Gugi-dong, Yejang-dong, Jeo-dong 2-ga | Hwigyeong-dong, Cheolsan-dong, Hoegi-dong | beta |

Demo order: NYC, London, LA first; beta cities labelled in the UI.

## Architecture

```
Browser (React + Vite + MapLibre)  ──HTTPS / SSE──▶  Node 22 backend (Fly.io, 1 machine)
                                                     ├─ Pipeline (deterministic)
                                                     ├─ Agent (Gemini Flash; Groq fallback)
                                                     ├─ Qloo client (REST, queue 4 rps, retries)
                                                     ├─ Neighborhood index (OSM points, 12 cities)
                                                     └─ Cache (memory LRU + SQLite on Fly volume)
```

### Pipeline

1. **Resolve** chips via `/search` (cached by normalized query + type).
2. **Heatmap** per person: one insights call, `take=50`, city query.
3. **Taste lift.** Per cell, `lift = affinity − f(popularity)` where `f` is a
   per-response linear fit. Drop cells below a popularity floor. Assign each
   cell to the nearest OSM `place=suburb|neighbourhood|quarter` point within
   1.5 km and aggregate (mean lift weighted by popularity). Same method for
   curated and beta cities; no polygons needed.
4. **Blend** score `min(A, B)`. Compare's shared tags are per-pair, not
   per-neighborhood, so they explain the blend in the UI but do not rank.
5. **Places** for top neighborhood: place insights with signals +
   `filter.location.query="<hood>, <city>"`.
6. **Explain + plan** via LLM, constrained to returned evidence (JSON schema
   output, entity IDs must exist in evidence).

### Agent

Gemini function calling with tools: `resolve_entity`, `refine_neighborhoods`,
`find_places`, `compare_tastes`. Used for free-text parsing, explanations,
plans, and refinement turns. The core result never depends on the LLM.

### Secrets

`QLOO_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` in gitignored `.env` locally
and Fly secrets in production. Never in the client bundle or logs.

## Error handling

- Qloo queue at 4 rps; on 429 wait `x-second-ratelimit-reset` then retry ≤2;
  5xx/timeout retry once; other 4xx surface as typed errors.
- Track `x-month-ratelimit-remaining`; below a floor switch to cache + demo
  profiles only with a visible banner.
- Ambiguous/empty search → "did you mean" chips. Sparse heatmap → beta label,
  wider aggregation.
- LLM failure → Groq → template explanations from evidence.
- Per-IP limit on live runs; zod input validation; no personal data stored.

## Testing

- Unit: lift scoring, blend scoring, point-in-polygon aggregation, Qloo client
  retry/throttle — all against recorded fixtures (zero quota).
- Manual live smoke per endpoint before deploy.
- Playwright E2E on demo profiles against the deployed URL.
- Thesis check: two contrasting profiles yield different top-3 neighborhoods in
  ≥10 of 12 cities.

## Milestones

1. Oct 5–8: Qloo client, fixtures, lift tuning (Lisbon, NYC, London). Go/no-go.
2. Oct 9–14: pipeline + SSE, GeoJSON for 12 cities, Gemini parse/explain.
3. Oct 15–20: UI — chips, map, results, modes.
4. Oct 21–24: blend, refine chat, warmed demo profiles.
5. Oct 25–27: Fly deploy, public repo (MIT), README, tests, QA.
6. Oct 28–29: Devpost write-up and gallery; buffer day.

## M4 QA (2026-10-07)

API-level end-to-end through the Vite proxy (`.scratch/e2e.mjs`), after a
fresh server start with demo warm-up (3/3 warmed; demo runs then cost 0 Qloo
calls):

| Demo | Top hoods | Notes |
| --- | --- | --- |
| nyc-indie | Greenpoint, Williamsburg, Red Hook (strong) | Desert Island, Beacon's Closet, Land to Sea… |
| nyc-blend | Sunnyside, Saint George, Tompkinsville (moderate) | Shared: Blues, Drums, Jazz, Folk, Rock… Dutch Kills |
| la-visit | Dolanco Junction, Westside Village, San Pedro (moderate) | Food-heavy spots for a visiting taste |

Guide agent live: "somewhere quieter" → Quiet tag → quiet Greenpoint spots
(2.9 s via Groq). "More nightlife, show me Williamsburg" → focus + Nightlife (0)
→ retry "night club" → The Whiskey Annex, The Woods.

Defects found and fixed: an adult venue in LA spots (genre `night_club`);
29 duplicated shared tags (compare ignores `take`); Groq rejected tool calls
missing optional fields; the agent hallucinated venues when Qloo returned none
(now guarded); a weak London blend demo replaced by an NYC blend.

Pending: visual pass in a real browser (automation was interrupted twice).
