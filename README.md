# CamDX KYC Verification

A web application for Cambodian identity verification, integrating the six
CamDigiKey KYC APIs defined by CamDX.

A user uploads a Cambodian National ID Card, reviews the extracted identity
details, chooses a verification method, supplies anything extra that method
needs, and receives a plain-language verification report. They never see JSON, an
endpoint, or a technical error.

> **Status: Phase 1 — Foundation complete and validated.**
> The app runs, the health checks pass, and the Docker stack builds and serves.
> The upload, OCR, face detection and verification features begin in Phase 2.

---

## What this application does

1. Accept a Cambodian National ID Card image
2. Extract identity information (CamDigiKey Khmer ID Card OCR)
3. Detect and crop the face printed on the card (local OpenCV — *not* a verification)
4. Let the user correct anything the OCR got wrong
5. Offer the six supported verification methods, each asking only for its own inputs
6. Capture a current face and/or a liveness session where the chosen method needs one
7. Run the matching CamDigiKey verification
8. Report the outcome in plain language, with matched fields and next actions

The six CamDigiKey APIs:

| # | Official API | Purpose |
|---|--------------|---------|
| 1 | Verify User Info | Check user-supplied identity data |
| 2 | Verify User Info + User Face | Add a current face comparison |
| 3 | Verify User Info + ID Card + User Face | Add the submitted ID Card |
| 4 | Verify User Info + ID Card Image + Liveness | Add a liveness session |
| 5 | Khmer ID Card OCR | Read a Cambodian National ID Card |
| 6 | Passport OCR | Read a passport |

---

## Architecture

```text
┌────────────────────┐
│     React SPA      │  browser — talks only to our backend
└─────────┬──────────┘
          │ HTTPS / JSON / multipart
┌─────────▼──────────┐
│  FastAPI API       │  application layer
└─────────┬──────────┘
          │
  ┌───────┼───────────┬──────────────────┐
  ▼       ▼           ▼                  ▼
Document  Face       KYC Service    Requirement Engine
Service   Service        │          (single source of truth)
  │         │            ▼
CamDX      OpenCV   CamDXProvider
  OCR    (detection)      │
                    ┌────┴─────┐
                    │          │
              MockProvider  RealProvider
                    └────┬─────┘
                         ▼
                  CamDigiKey APIs
```

Four layers, dependencies pointing inward only. `app/domain` is pure — no I/O, no
framework — which is what makes the requirement rules and the state machine
directly testable.

Full detail: **[docs/architecture.md](docs/architecture.md)**

### Three rules the architecture enforces structurally

**Face detection ≠ face verification.** OpenCV crops the face from an ID card;
CamDigiKey performs verification. `FaceExtraction` has no `verified` or `score`
field at all, so a local detection *cannot* be rendered as a government identity
check, even by accident. The only source of a face-verification claim is a CamDX
response.

**Requirements are computed, not hard-coded.** One matrix in
`backend/app/domain/requirements.py` drives the UI (served via
`GET /api/v1/kyc/verification-methods`) and the backend's independent validation.
Frontend and backend cannot disagree without a contract test failing.

**No technical text escapes.** Upstream errors pass through a translation layer
into business codes with sentences written for a person. No upstream status,
endpoint, payload or score appears in a response or in the UI.

---

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

The whole product — frontend **and** API — is then at **http://localhost:8000**.

```bash
docker compose --profile db up -d     # optional PostgreSQL (unused in Phase 1)
docker compose down -v                # stop; -v also deletes biometric temp files
```

### One container, one port

`app` builds the SPA and serves it **and** the API, so the whole product is at
**http://localhost:8000**. There is no second frontend container and nothing
listens on 5173 under Docker.

| URL | |
|---|---|
| http://localhost:8000 | the application (frontend + API) |
| http://localhost:8000/health | liveness |
| http://localhost:8000/api/v1/health | readiness |
| http://localhost:8000/docs | API docs |

For frontend work with hot reload, run Vite on the host alongside the container —
see below. That is the only case where 5173 is used.

### Local development

```bash
make setup            # venv + npm install
make backend-run      # API on :8000 with reload
make frontend-run     # Vite on :5173, proxying /api to :8000  ← frontend dev loop
make check            # lint, format, typecheck, tests — both sides
```

Two ways to run the frontend, and they are not interchangeable:

| How | URL | Use when |
|-----|-----|----------|
| `make docker-up` | :8000 | Testing the real build, or anything containerised |
| `make frontend-run` | :5173 | Writing frontend code — Vite HMR, proxies `/api` to :8000 |

Requires Python 3.11–3.13 and Node 20.19+. Python is capped below 3.14 for
OpenCV wheel availability; the Docker image pins 3.12 regardless of the host.

---

## Configuration

All settings live in `backend/app/core/config.py`. `.env.example` lists them all.

| Variable | Default | Notes |
|----------|---------|-------|
| `CAMDX_MODE` | `mock` | `mock` or `real` |
| `CAMDX_BASE_URL` / `CAMDX_CLIENT_ID` / `CAMDX_CLIENT_SECRET` | — | Required for `real` |
| `CAMDX_API_KEY` | — | Only if the integration needs one |
| `CAMDX_TIMEOUT` | `30` | Seconds |
| `CAMDX_EXPOSE_DEVELOPER_VIEW` | `false` | Adds a dev-only block to results |
| `LOG_SENSITIVE_PAYLOADS` | `false` | **Unsafe.** Payload logging |
| `CORS_ORIGINS` | `http://localhost:5173` | Explicit list; wildcards rejected |
| `MAX_UPLOAD_BYTES` | `10485760` | Hard upload cap |
| `TEMP_ARTIFACT_TTL_SECONDS` | `900` | Biometric artefact lifetime |
| `TEMP_STORAGE_DIR` | `var/tmp` | Must stay outside any static mount |
| `DATABASE_URL` | — | Declared, **unused** in Phase 1 |

`.env` is git-ignored. No credential is committed, and none is ever baked into an
image — compose reads them from the host environment.

---

## Mock mode

The default. `MockCamDXProvider` answers all six APIs from fixtures with no
network and no credentials. Outcomes are deterministic and steered by documented
triggers (for example a national ID of `000000000` produces an identity
mismatch), so tests never flake.

`MockLivenessProvider` is a **separate class** so the real liveness
implementation replaces only that piece.

Switching to `CAMDX_MODE=real` requires no frontend change and no service change —
only implementing the six adapter modules and the normalizer. In real mode the
backend refuses to start if credentials are incomplete, rather than silently
serving fixtures.

Open questions about the real contract (endpoint paths, liveness flow, OCR field
formats) are listed rather than guessed in
[docs/camdx-integration.md](docs/camdx-integration.md) §7.

---

## Privacy

ID Card and face images are treated as sensitive biometric data.

- No static mount serves user uploads; artefacts are reached only by opaque,
  time-limited handle
- Artefacts are temporary and swept after `TEMP_ARTIFACT_TTL_SECONDS`
- No face embeddings are computed or stored, ever
- A logging filter redacts national IDs, names, artefact paths, handles and
  credentials — asserted by tests
- CamDX credentials are server-side only; the browser bundle contains no
  credential, endpoint or CamDigiKey host

Lifecycle: [docs/data-privacy.md](docs/data-privacy.md)

---

## Testing

```bash
make check
```

| Level | Location | Covers |
|-------|----------|--------|
| Unit | `backend/tests/unit/` | config, error taxonomy, log redaction |
| Integration | `backend/tests/integration/` | health, SPA serving, error envelope |
| Component | `frontend/src/**/*.test.tsx` | routing, shell, not-found |
| E2E | `tests/e2e/` | Scenarios A–I (added per phase) |

No test contacts the real CamDigiKey service. Mock mode is forced in
`conftest.py`. Biometric fixtures are synthetic; no real document enters the
repository.

Strategy: [docs/testing.md](docs/testing.md)

---

## Project layout

```text
camdx-kyc/
├── backend/
│   ├── app/
│   │   ├── main.py              app factory, middleware, SPA serving
│   │   ├── core/                config, logging + redaction, errors, ids
│   │   ├── api/                 routers and DI providers
│   │   ├── schemas/             transport DTOs
│   │   ├── domain/              pure business rules (no I/O)
│   │   ├── services/            document, face, kyc
│   │   ├── integrations/camdx/  the CamDigiKey adapter (mock | real)
│   │   └── infrastructure/      temp storage, imaging, db
│   └── tests/
├── frontend/
│   └── src/
│       ├── app/                 shell, router, error boundary
│       ├── pages/               landing, workspace
│       ├── features/            one folder per capability
│       ├── components/          ui primitives + domain widgets
│       ├── config/              api client
│       └── lib/                 framework-agnostic helpers
├── docs/
├── tests/                       contract, e2e, fixtures
├── docker-compose.yml
├── Makefile
└── .env.example
```

---

## Documentation

| Document | Contents |
|----------|----------|
| [architecture.md](docs/architecture.md) | Layers, module map, dependency direction |
| [api.md](docs/api.md) | Application endpoints, error envelope, status codes |
| [camdx-integration.md](docs/camdx-integration.md) | The six APIs, provider port, error translation, open questions |
| [verification-flow.md](docs/verification-flow.md) | End-to-end flow, requirement-driven inputs, report rules |
| [data-privacy.md](docs/data-privacy.md) | Data lifecycle, logging policy, controls |
| [development.md](docs/development.md) | Setup, commands, conventions, troubleshooting |
| [testing.md](docs/testing.md) | Levels, rules, scenarios A–I |
| [implementation-plan.md](docs/implementation-plan.md) | Phases, exit criteria, decisions, risks |

---

## Development phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Foundation, Docker, config, health | **Done** |
| 2 | Landing page, upload, validation | Next |
| 3 | ID Card processing, OCR, face detection | |
| 4 | Three-column workspace, editable form | |
| 5 | Verification method engine, CamDX adapter | |
| 6 | Current face capture | |
| 7 | Liveness | |
| 8 | Passport OCR | |
| 9 | Verification report | |
| 10 | Hardening, security, full test suite | |

Each phase has explicit exit criteria that must be demonstrated before the next
begins. Detail: [docs/implementation-plan.md](docs/implementation-plan.md)