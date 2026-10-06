# Transplant M5 — Ship Plan

**Goal:** A public, judge-ready deployment: one Fly.io machine serving the API and the built web app over HTTPS, a public GitHub repo with MIT license, README, and CI.

**Facts checked 2026-10-07:** Fly shared-cpu-1x is $2.19/mo at 256 MB, $4.39/mo at 512 MB, billed per second while running (fly.io/pricing). flyctl installs on Windows with `iwr https://fly.io/install.ps1 -useb | iex`. Local: Docker 27.5.1, gh 2.58 logged in as `mukeshkbj` (repo scope). Git history scanned for key patterns (`hack_`, `AIza`, `AQ.`, `gsk_`): none; no `.env`, cache, or scratch files tracked.

## Tasks

1. **Serve the SPA from Hono** (TDD): optional `staticRoot` dep/`STATIC_ROOT` env; hashed `/assets/*` get `immutable` caching, `index.html` gets `no-cache`; unknown non-API GETs fall back to `index.html`; unknown `/api/*` stays a JSON 404.
2. **Container**: move `tsx` to runtime deps; two-stage `Dockerfile` on `node:24-slim` (build web → runtime with prod deps, `server/`, `dist/web`); `.dockerignore` excludes secrets, caches, tests, docs, git. Build locally, run with `--env-file .env`, smoke `/api/health`, `/`, a demo transplant.
3. **Fly config**: `fly.toml` with HTTPS, `/api/health` check, volume `/data` for the SQLite cache, `shared-cpu-1x` 512 MB, `min_machines_running = 1` during judging (avoids cold starts).
4. **Repo hygiene**: MIT `LICENSE`, `README.md` (pitch, how Qloo is used, setup, scripts, architecture diagrams, attribution, limitations), GitHub Actions CI (typecheck, tests, web build).
5. **Publish (needs user OK)**: create public repo `transplant` under `mukeshkbj`, push `main`, set the About description/topics so the license shows.
6. **Deploy (needs user Fly login)**: install flyctl, `fly auth login` (user), `fly launch --no-deploy` with the committed config, create the volume, `fly secrets import < .env` (values never printed), `fly deploy`, smoke the public URL, record it in README.
7. **Devpost** (M6): use the `devpost-submission` skill.
