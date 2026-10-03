# Development Guide

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Docker + Compose | any recent | Primary path — `v2` syntax |
| Python | 3.11, 3.12 or 3.13 | `>=3.11,<3.14`; see below |
| Node.js | 20+ | 22 LTS recommended |
| npm | 10+ | ships with Node |

**Why not Python 3.14?** `opencv-python-headless` publishes `abi3` wheels that
install on 3.14, but pinned/older environments and some transitive builds do not.
The supported range is capped at `<3.14` for reproducibility (D12). Docker pins
`python:3.12-slim`, so the container is unaffected by the host interpreter.

---

## 2. Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build
```

| Service | URL |
|---------|-----|
| Application (frontend **and** API) | http://localhost:8000 |
| Health | http://localhost:8000/health |
| Readiness | http://localhost:8000/api/v1/health |
| API docs | http://localhost:8000/docs |

There is **one** container and **one** port. `app` builds the SPA and serves it
alongside the API, so the product is single-origin (§30).

Postgres is **not** started by default (§4, D6):

```bash
docker compose --profile db up -d postgres
```

Stop and clean up, including the temp artefact volume:

```bash
docker compose down -v
```

**No frontend container.** An earlier revision shipped a `frontend` service
(nginx serving the same `dist`) behind a `dev` profile. It was removed: nothing
listened on 5173 under a plain `docker compose up`, so the conventional frontend
port looked like a broken build even though the SPA was running fine on 8000. If
you previously started it, remove any leftover container once:

```bash
docker rm -f camdx-kyc-frontend-1 2>/dev/null || true
```

**Healthcheck note:** every container probes `127.0.0.1`, never `localhost`.
`localhost` resolves to `::1` first in the alpine and slim base images, while the
servers bind IPv4 only, so a `localhost` probe reports a healthy service as
unhealthy.

---

## 3. Local development without Docker

### Backend

```bash
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example ../.env            # or export variables yourself
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/health` to `http://localhost:8000`
(`frontend/vite.config.ts`), so the browser sees a single origin and no CORS
configuration is needed in development.

### Commands

```bash
# backend
make backend-test        # pytest
make backend-lint        # ruff check
make backend-format      # ruff format
make backend-typecheck   # mypy

# frontend
make frontend-test       # vitest run
make frontend-lint       # eslint
make frontend-typecheck  # tsc --noEmit
make frontend-build      # vite build

# everything
make check               # lint + typecheck + tests, both sides
```

---

## 4. Environment variables

`backend/app/core/config.py` is the single definition; `.env.example` is
generated to match it. Copy `.env.example` to `.env` — `.env` is git-ignored and
must never be committed (§22).

| Variable | Default | Purpose |
|----------|---------|---------|
| `APP_ENV` | `local` | `local` \| `docker` \| `staging` \| `production` |
| `APP_HOST` | `0.0.0.0` | Bind address |
| `APP_PORT` | `8000` | Bind port |
| `LOG_LEVEL` | `INFO` | Log verbosity |
| `LOG_SENSITIVE_PAYLOADS` | `false` | **Unsafe.** Allows payload logging; never enable in a shared environment |
| `CAMDX_MODE` | `mock` | `mock` \| `real` (§21) |
| `CAMDX_BASE_URL` | — | Required when `CAMDX_MODE=real` |
| `CAMDX_CLIENT_ID` | — | Required when `CAMDX_MODE=real` |
| `CAMDX_CLIENT_SECRET` | — | Required when `CAMDX_MODE=real` |
| `CAMDX_API_KEY` | — | Optional, per CamDX |
| `CAMDX_TIMEOUT` | `30` | Seconds |
| `CAMDX_EXPOSE_DEVELOPER_VIEW` | `false` | Adds `developerView` to results (§24, D10) |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allow-list |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MB) | Hard upload cap (§29) |
| `MIN_IMAGE_WIDTH` / `MIN_IMAGE_HEIGHT` | `640` / `400` | Minimum resolution |
| `TEMP_STORAGE_DIR` | `var/tmp` | Outside every static path |
| `TEMP_ARTIFACT_TTL_SECONDS` | `900` | Biometric artefact lifetime |
| `TEMP_SWEEP_INTERVAL_SECONDS` | `60` | Sweeper cadence |
| `DATABASE_URL` | — | Postgres DSN; **unused in Phase 1** (D7) |

In `CAMDX_MODE=real` the backend refuses to start if the required credentials are
absent. It never silently falls back to mock (§21).

---

## 5. Adding configuration

1. Add the field to `Settings` in `app/core/config.py` with a default and a
   description.
2. Add it to `.env.example`.
3. Reference it through the injected `Settings` — never `os.environ` directly, so
   tests can override it deterministically.

---

## 6. Coding conventions

### Backend

- `ruff` for lint and format; `mypy --strict` for `app/domain`
- Layered imports only (`docs/architecture.md` §2); `app/domain` imports nothing
  from the project but the standard library
- Type annotations everywhere; no bare `dict` in a public signature
- Docstrings explain *why*, not *what*
- Business codes live in `core/errors.py`; never raise a bare `HTTPException`
  from a service

### Frontend

- TypeScript `strict`; no `any`
- Feature folders own their components, hooks and types; cross-feature imports go
  through the feature's public index
- All network access through `src/config/apiClient.ts`
- Tailwind utilities for styling; no inline style objects except for dynamic
  geometry (e.g. bounding-box overlay)
- No `console.log` of blobs, handles or payloads (§29)

---

## 7. Working on a phase

```text
1. Read the phase scope in docs/implementation-plan.md
2. Confirm the phase's exit criteria are checkable
3. Implement, with tests in the same change
4. Run make check
5. Demonstrate every exit criterion, including in Docker
6. Only then start the next phase
```

Per §38: no unresolved errors at phase exit, no skipped tests, no silently changed
requirements, no invented CamDX behaviour, mock and real kept separate.

---

## 8. Split deployment (optional, not the default)

The supported shape is one container serving the SPA and the API — single origin,
no CORS, no second surface to secure. Do not split it without a reason.

If you must serve the SPA from a separate host, `frontend/Dockerfile` and
`frontend/nginx.conf` implement it: nginx serves `dist` and proxies `/api` and
the health probes to the backend, so the browser still only ever addresses one
origin. Change the `upstream backend` server address for a non-Compose
deployment.

Two constraints that config already encodes and that any replacement must keep:

- `try_files … /index.html` — without it, refreshing `/id-card` 404s, because
  client-side routing means the browser requests that path directly.
- `proxy_set_header X-Request-Id $request_id` — without it, error reports cannot
  be traced (§28).

Neither file is exercised by the default stack or by CI, so treat a split
deployment as untested until you have verified it end to end.

---

## 9. Common tasks

**Point the backend at a real CamDX sandbox**

```bash
CAMDX_MODE=real CAMDX_BASE_URL=... CAMDX_CLIENT_ID=... CAMDX_CLIENT_SECRET=... \
  uvicorn app.main:app --reload
```

**Clear stale artefacts**

```bash
rm -rf backend/var/tmp/*        # local
docker compose down -v          # containers
```

**Check what the backend resolved**

```bash
curl -s localhost:8000/api/v1/health | jq
```

**Regenerate API docs after an endpoint changes**

```bash
curl -s localhost:8000/openapi.json | jq '.paths | keys'
```

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backend exits at startup with `ConfigurationError` | `CAMDX_MODE=real` without credentials | Supply credentials, or use `CAMDX_MODE=mock` |
| Frontend 404s on `/api` | Dev proxy not applied | Restart Vite; confirm `vite.config.ts` proxy |
| `uvicorn` not found | venv not active | `source backend/.venv/bin/activate` |
| `opencv` import error | Interpreter outside `>=3.11,<3.14`, or missing headless wheel | Use 3.12 and `pip install -e ".[dev]"` |
| Port 5173 or 8000 in use | Previous run still alive | `lsof -ti:5173 \| xargs kill` |
| `mypy` errors after `pip install -e` | Missing dev extras | `pip install -e ".[dev]"` |