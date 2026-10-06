# Transplant

**Find the neighborhood that already loves what you love.**

Tell Transplant a few things you love — artists, shows, films, brands, the kind of places you seek out — and pick a city. It maps where people with your exact taste cluster, ranks the neighborhoods that fit, finds the local spots, and plans your first week (or your trip). Moving with someone? Blend both tastes and find the neighborhood that works for both of you.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

- **Live demo:** _added after deployment_
- **Architecture:** [docs/architecture/transplant-architecture.html](docs/architecture/transplant-architecture.html)
- **Why Qloo, not another API:** [docs/architecture/qloo-vs-alternatives.html](docs/architecture/qloo-vs-alternatives.html)

## Why it needs Qloo

An LLM on its own recommends the famous tourist neighborhoods. Transplant answers a different question: *where does this specific combination of taste over-index?* That needs a cross-domain taste graph with geography:

| Step | Qloo API |
| --- | --- |
| Resolve "Aesop" to the brand, not the author; "natural wine bars" to a tag | `/search` (typed), `/v2/tags` |
| Heatmap of where your combined taste lives in the city | `/v2/insights` with `filter.type=urn:heatmap` |
| Taste-matched places around the winning neighborhood | `/v2/insights` with `filter.type=urn:entity:place`, `filter.location=POINT(...)` |
| What two people share | `/v2/analysis/compare` |
| Guide agent: "quieter", "more nightlife" | `/v2/tags` (place-scoped) + place insights with `filter.tags` |

### Taste lift

Raw heatmap affinity correlates 0.95–0.98 with popularity, so a naive map sends everyone downtown. Transplant regresses affinity on popularity per city and ranks neighborhoods by the residual — the **taste lift** — aggregated over Qloo cells within 1.5 km of each OpenStreetMap neighborhood, with a shrinkage prior, a minimum of 4 cells, and at least 1 km between ranked neighborhoods. Blends rank by the weaker person's lift. Validation across 12 cities is in [the design doc](docs/plans/2026-10-04-transplant-design.md).

## Features

- **Taste stamps** — free text becomes confirmable Qloo entities and tags; ambiguous picks ask "Which 'Lost'?".
- **Night map** — the taste heatmap over the city, top 3 neighborhoods, signal strength, and evidence counts.
- **Local spots and a plan** — curated Qloo places (adult venues and infrastructure filtered out) and a first week or itinerary written by an LLM that may only cite places Qloo returned.
- **Blend** — two people, one neighborhood, plus shared tastes.
- **Guide agent** — a tool-using agent (`find_tags`, `find_places`, `focus_hood`) that refines results through live Qloo calls and shows its trace. It can only use neighborhoods you were shown and tag IDs Qloo returned; if Qloo finds nothing, it says so instead of inventing places.
- **Demos and share links** — three ready-made tastes (cached, so they work even when quota is low) and links that rerun a result.

## Run it locally

Requirements: Node.js 22.19+ (24 recommended), a Qloo hackathon API key, a Gemini API key; a Groq key is optional but recommended (used first by the agent, fallback for the story).

```bash
npm ci
cp .env.example .env   # fill in QLOO_API_KEY, GEMINI_API_KEY, GROQ_API_KEY
npm run dev            # API on http://localhost:8787
npm run web            # web app on http://localhost:5173 (proxies /api)
```

| Script | Purpose |
| --- | --- |
| `npm test` | Vitest (server + web, no network calls) |
| `npm run typecheck` | TypeScript |
| `npm run build:web` | Production web build into `dist/web` |
| `npm run lift-report` | Neighborhood ranking report from recorded Qloo fixtures |
| `npm run demos` | Re-resolve demo profiles (uses Qloo, cached) |
| `npm run hoods` | Re-fetch OpenStreetMap neighborhood points |

### Docker / Fly.io

```bash
docker build -t transplant .
docker run -p 8787:8787 --env-file .env -v transplant-cache:/data transplant
```

`fly.toml` runs one always-on machine with a volume for the Qloo response cache. Secrets are set with `fly secrets`, never baked into the image.

## Responsible use

- Only cultural entity names and tags go to Qloo — no names, accounts, or locations of users.
- Results are aggregate cultural affinities, not predictions about any individual; the UI says so.
- Qloo's hackathon quota (10,000 calls/month) is protected by a 4 req/s queue, a SQLite response cache, a monthly floor, and per-IP rate limits.

## Limitations

- Lisbon, Tokyo, and Seoul are labeled beta: Qloo signal there is thinner or OSM neighborhoods are very fine-grained.
- Qloo tag coverage for places is uneven (e.g. "nightlife" can return nothing where "night club" works); the guide retries once with a more concrete tag.
- The LLM writes copy only; rankings and places come from Qloo and deterministic code.

## Attribution

Taste data: [Qloo](https://www.qloo.com/). Neighborhood points © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Map tiles: [OpenFreeMap](https://openfreemap.org/). LLMs: Google Gemini and Groq.

## License

[MIT](LICENSE)
