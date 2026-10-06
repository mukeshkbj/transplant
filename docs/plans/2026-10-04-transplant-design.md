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

## Architecture

```
Browser (React + Vite + MapLibre)  ──HTTPS / SSE──▶  Node 22 backend (Fly.io, 1 machine)
                                                     ├─ Pipeline (deterministic)
                                                     ├─ Agent (Gemini Flash; Groq fallback)
                                                     ├─ Qloo client (REST, queue 4 rps, retries)
                                                     ├─ Neighborhood index (GeoJSON, 12 cities)
                                                     └─ Cache (memory LRU + SQLite on Fly volume)
```

### Pipeline

1. **Resolve** chips via `/search` (cached by normalized query + type).
2. **Heatmap** per person: one insights call, `take=50`, city query.
3. **Taste lift.** Per cell, `lift = affinity − f(popularity)` where `f` is a
   per-response linear fit. Drop cells below a popularity floor. Aggregate
   cells into neighborhoods by point-in-polygon (mean lift weighted by
   popularity). Beta cities: aggregate to geohash-5 and label via locality
   search.
4. **Blend** score `min(A, B) + λ · sharedTagScore`.
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
