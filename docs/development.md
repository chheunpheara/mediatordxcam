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
| Application (SPA) — `frontend` container | http://localhost:3000 |
| Health through the proxy | http://localhost:3000/health |
| API docs through the proxy | http://localhost:3000/docs |
| API — `app` container, direct | http://localhost:8000/api/v1/health |
| API docs, direct | http://localhost:8000/docs |

**Two containers, two ports, one origin for the browser.** `frontend` builds the
SPA and serves it with nginx on :3000, proxying `/api`, `/health`,
`/health/ready`, `/docs`, `/openapi.json` and the `/ws` relay to `app` on :8000.
The browser only addresses :3000, so the product stays single-origin from its
point of view and needs no CORS configuration (§30). `app` is API-only and ships
no static files.

**PostgreSQL starts with the stack** (D13): it is the sample identity registry
verification compares against, so `app` waits for it to become healthy and is
given its in-network DSN. Three obviously-fake records are seeded on first start
(§16 — nobody can mistake them for real identities):

| National ID | What it is for |
|-------------|----------------|
| `000000000000` | The card the mock OCR reads. OCR leaves the date of birth blank — enter `1992-07-18` for a full success, any other date for a one-field §26 partial |
| `123456789` | The straightforward success case: submit the stored fields exactly (Sokha Cham, DOB `1994-02-11`) |
| `111111111` | Take an OCR-processed identity and swap only the national ID here: date of birth, gender and last name mismatch at once → §26 multi-field partial |
| anything else | Unknown → `failed` |

Running the backend on the host instead (`make backend-run`)? Its `DATABASE_URL`
comes from `.env`; leave it empty and verification runs on bundled fixtures with
no database at all — which is also exactly what the test suite does.

Stop and clean up, including the temp artefact volume and the seeded database:

```bash
docker compose down -v
```

**Healthcheck note:** every container probes `127.0.0.1`, never `localhost`.
`localhost` resolves to `::1` first in the alpine and slim base images, while
the servers bind IPv4 only, so a `localhost` probe reports a healthy service as
unhealthy. The `frontend` service waits for `app` to become healthy before it
starts, because nginx resolves `upstream backend` once at startup.

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
must never be committed (§22). The `POSTGRES_*` variables in `.env.example` are
the exception: they are consumed by the `postgres` service in compose, not by
`Settings` (D13).

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
| `OCR_PROVIDER` | `mock` | `mock` fixtures or real capture via local `tesseract` |
| `OCR_LANGUAGES` | `eng+khm` | Tesseract language codes |
| `OLLAMA_BASE_URL` | — | Local Ollama server for NLP capture (Docker: `host.docker.internal`) |
| `OLLAMA_MODEL` | `llama3.1` | Ollama model for field extraction |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allow-list |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MB) | Hard upload cap (§29) |
| `MIN_IMAGE_WIDTH` / `MIN_IMAGE_HEIGHT` | `640` / `480` | Minimum resolution (must match `frontend/src/features/document-upload/validation.ts`) |
| `TEMP_STORAGE_DIR` | `var/tmp` | Outside every static path |
| `TEMP_ARTIFACT_TTL_SECONDS` | `900` | Biometric artefact lifetime |
| `TEMP_SWEEP_INTERVAL_SECONDS` | `60` | Sweeper cadence |
| `DATABASE_URL` | — | Identity-registry DSN (D13). Empty = fixture verification, no database needed |
| `AUTH_ENABLED` | `true` | Gates every API route behind sign-in (D18). Set `false` only for local API exploration; the test suite forces it off. Auth tables use `DATABASE_URL`, falling back to `var/auth.db` when unset |

In `CAMDX_MODE=real` the backend refuses to start if the required credentials are
absent. It never silently falls back to mock (§21).

On first start the auth store seeds idempotently: the roles `Admin`,
`Senior Loan Officer` and `Loan Officer`, plus the account
`admin@gmail.com` / `P4ssw0rd!` (requirement 5 — a documented placeholder; a
deployment's first act is changing it). The login page is `http://localhost:3000/login`
in Docker; sign-out and the `Administration` link live in the header.

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
- All network access through `src/lib/api.ts`
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

## 8. Serving topology

The default stack is two containers on two ports:

```text
browser ──► frontend :3000 (nginx: SPA + reverse proxy)
                 │  /api, /health, /health/ready, /docs, /openapi.json, /ws
                 ▼
              app :8000 (FastAPI, API only — no static files)
                 │
                 ▼
           CamDigiKey (server-side only, CAMDX_* credentials)
```

`frontend/Dockerfile` builds the SPA and `frontend/nginx.conf` serves it while
proxying the API paths to the `app` service, so the browser still only ever
addresses one origin. The backend image deliberately ships no `dist`: with the
SPA reachable from exactly one container, there is no second bundle to drift out
of sync, and no static directory that a future mount could accidentally point at
user uploads (§29).

Constraints the nginx config already encodes and any replacement must keep:

- `try_files … /index.html` — without it, refreshing `/id-card` 404s, because
  client-side routing means the browser requests that path directly.
- `proxy_set_header X-Request-Id $request_id` — without it, error reports cannot
  be traced (§28).
- `/health` and `/docs` are proxied explicitly — the SPA fallback would otherwise
  answer them with HTML, which reads as healthy-but-wrong to an orchestrator.
- `/ws` is proxied with the upgrade headers (`Upgrade`, `Connection`) and a long
  read timeout — the fallback would answer the handshake with HTML, the socket
  would never open, and the teller screen would wait for webcam frames forever.
- No `CAMDX_*` variable is passed to this container. It serves static files; it
  has no reason to hold a credential (§30).

For a non-Compose deployment, change the `upstream backend` server address and
verify deep links, the proxy and both health probes end to end.

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
| Backend exits at startup with `ConfigurationError`, message mentions the registry | `DATABASE_URL` set but unreachable/malformed (D13 fail-fast) | Start Postgres (`docker compose up -d postgres`), or clear `DATABASE_URL` for fixture verification |
| Verification returns 502 `UPSTREAM_UNAVAILABLE` | Database went away after startup | Check `docker compose ps`; the message is deliberately DSN-free |
| Every identity field shows mismatch and `failed` | National ID absent from the registry — no record means nothing could match (§27) | Use a seeded ID from §2, or `docker compose down -v` + up to reseed; this is the designed unknown-ID outcome |
| Frontend 404s on `/api` | Dev proxy not applied | Restart Vite; confirm `vite.config.ts` proxy |
| `uvicorn` not found | venv not active | `source backend/.venv/bin/activate` |
| `opencv` import error | Interpreter outside `>=3.11,<3.14`, or missing headless wheel | Use 3.12 and `pip install -e ".[dev]"` |
| Port 3000 or 8000 in use | Previous run still alive (Vite, Docker, or uvicorn) | Free :3000 with `docker compose stop frontend` or `lsof -ti:3000 \| xargs kill`; free :8000 with `lsof -ti:8000 \| xargs kill` |
| `mypy` errors after `pip install -e` | Missing dev extras | `pip install -e ".[dev]"` |