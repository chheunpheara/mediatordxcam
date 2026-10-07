# Implementation Plan and Requirements

Rewritten against the tree as it stands at commit `e02da63`. Phases 1–7 are
shipped and green, Phase 9 is partially shipped, Phases 8 and 10 are open.
Every claim names the module that implements it; an unfinished phase keeps the
exit criteria it still owes. Decisions are in §7, risks in §6.

Current gate: `make check` passes — **565** backend tests (pytest, `ruff`,
`mypy --strict`) and **372** frontend tests across 39 files (eslint, tsc,
vitest).

---

## 1. Requirements

### 1.1 Functional, as implemented

| # | Requirement | Implemented by |
|---|-------------|----------------|
| R1 | Accept a Cambodian National ID image (JPG/PNG/WebP) with client-side type, size, readability and resolution gates, verbatim rejection messages, and a preview whose blob URL is revoked; the bytes survive a refresh in IndexedDB | `features/document-upload`, `pages/LandingPage`, `lib/session` |
| R2 | Process the card server-side: store → local OCR (Tesseract) → face detection and crop (OpenCV), returning the nine §14 identity fields; a Khmer name split runs through an offline/Ollama NLP path and low-confidence fields are flagged for the user | `services/documents.py`, `services/local_ocr.py`, `services/face.py`, `services/nlp_extract.py`, `POST /api/v1/kyc/id-card/process` |
| R3 | Present an editable identity form covering all nine fields, marking OCR-uncertain values rather than hiding them | `components/verification/IdentityForm`, `features/identity-form` |
| R4 | Offer the six official methods from one requirement matrix that the UI renders and the backend validates independently | `domain/requirements.py`, `GET /api/v1/kyc/verification-methods`, `components/verification/VerificationMethodPanel` |
| R5 | Capture the current face from the teller's own camera or an upload, gate it on exactly one detected face, and keep the handle in the session store | `features/face-capture`, `POST /api/v1/kyc/face-capture` |
| R6 | Record a liveness clip on a second screen: the teller's command opens the customer monitor's camera, frames stream back to the teller's preview at ~12 fps, a 3-second `MediaRecorder` clip is uploaded by the customer tab, and the teller adopts the server-issued handle into the artefact slot the verify call reads | `features/onboarding/*`, `pages/TellerDashboard`, `pages/CustomerDisplay`, `POST /api/broker/verify-liveness` |
| R7 | Take the current-face **photo** from the customer display: choosing a method that needs the customer's face enables that camera, the teller presses one button, and the still is uploaded through the existing face-capture pipeline | `features/onboarding/RemoteFaceCapture.tsx` |
| R8 | Run a method against only its own inputs, re-checked server-side (`422 REQUIREMENTS_NOT_MET`) so a bypassed UI cannot skip a requirement | `domain/requirements.py`, `services/kyc.py`, `POST /api/v1/kyc/verify` |
| R9 | Report the outcome in plain language: `success`/`partial`/`failed`, field rows with icon + word (never colour alone), section rows for face/ID card/liveness, and no JSON, endpoint, status code or score anywhere in the DOM | `domain/verification.py`, `components/verification/FieldCheckList`, `statusDisplay`, `sectionRows` |
| R10 | Require sign-in for the whole app, with roles whose permissions are exactly the six method ids, administered in an admin area | `features/auth`, `features/admin`, `services/auth.py`, `api/v1/endpoints/admin.py` |
| R11 | Leave an append-only audit entry for every action that touches an identity, maskable at the write boundary and readable only by an administrator | `infrastructure/audit_store.py`, `services/audit.py`, `GET /api/v1/admin/audit-logs` |
| R12 | Replay a result to configured core systems (HTTP Basic, per-target report, test connection) and manage bulk verification records | `api/v1/endpoints/integrations.py`, `api/v1/endpoints/records.py`, `features/records` |
| R13 | Export the verified values from the browser as xlsx, csv or json with column selection | `components/verification/exportData`, `ExportModal` |

### 1.2 Non-functional

- **N1 — Privacy.** No biometric data is persisted. Artefacts live in a
  temporary store behind opaque, TTL-swept handles and are streamed
  (`services/artifacts.py`), never statically mounted; every `/api/` response
  is `no-store`; logs are redacted (`core/logging`).
- **N2 — Detection is not verification.** `FaceExtraction` carries no
  `verified`/`score` field, so a local OpenCV crop cannot be rendered as a
  government identity check even by accident.
- **N3 — Requirements are computed, not hard-coded.** One matrix serves both
  sides; a contract test fails on drift (D2).
- **N4 — No technical text escapes.** Upstream errors pass a translation layer
  into business codes with sentences written for a person (§28).
- **N5 — Accessibility (§32).** Global focus ring, `role="status"`/`aria-live`
  regions for every asynchronous state, icon + text for status, keyboard-
  reachable controls, `prefers-reduced-motion` honoured.
- **N6 — Deterministic tests.** `conftest.py` forces `CAMDX_MODE=mock` and
  `DATABASE_URL=''`; no test touches a real CamDigiKey service, a real document
  or randomness.
- **N7 — One command validates the build.** `make check` runs identically in
  Docker and against a local venv.

### 1.3 Deliberately open

| Item | State |
|------|-------|
| Phase 8 — Passport OCR (API 6) | Not started. `/id-card/passport` exists as a route, the method reports `unavailable` with the backend's own reason. |
| Phase 9 recovery affordances | `KycResult.actions` is not built; the report renders status, fields and section rows but offers no next-step actions. |
| Contract tests (`tests/contract/`) and E2E (`tests/e2e/`, Playwright) | Directories reserved; Phase 10. |
| Rate limiting, full security-header and accessibility audit sign-off | Phase 10. |
| Real CamDX (CamDigiKey) providers | Seams isolated behind the provider port; open questions in `docs/camdx-integration.md`. |

### 1.4 Rules of execution

1. One phase at a time. No later phase is implemented until the current
   phase's acceptance is demonstrated.
2. No unresolved errors at phase exit - a failing check is fixed, not deferred.
3. Tests are written in the same phase as the code they cover.
4. No requirement is silently altered. A change is a documented decision in
   this file under "Decision log".
5. CamDX behaviour is never invented. Where the real contract is unknown, the
   seam is isolated behind `CamDXProvider` and the unknown is listed in
   `docs/camdx-integration.md` as an open question.
6. Mock and real implementations never share a code path.

---

## 2. System architecture

### 2.1 Overview

```text
                    Browser — React 19 SPA (Vite build, nginx or `vite dev`)
  ┌──────────────────────────────────────────────────────────────────────┐
  │  /login   /   /id-card   /admin   /teller        /display           │
  │  teller workspace (auth + admin)   customer monitor (public tab)    │
  └───────┬──────────────────────────────────────┬───────────────────────┘
          │ HTTPS  JSON / multipart              │ WSS  /ws/onboarding/{id}
          │ (cookie session)                     │ (role=teller|customer)
  ┌───────▼──────────────────────────────────────▼───────────────────────┐
  │  FastAPI (uvicorn; nginx proxies /api, /health, /docs)              │
  │  ┌──────────────┐ ┌────────────┐ ┌───────────┐ ┌──────────────────┐  │
  │  │ api/v1       │→│ services   │→│ domain    │ │ integrations/    │  │
  │  │ endpoints    │ │ (use cases)│ │ (pure)    │ │ camdx (port)     │  │
  │  └──────────────┘ └────────────┘ └───────────┘ └───┬──────────┬───┘  │
  │        │                │                          │          │      │
  │  ┌─────▼────────────────▼──────────┐        MockCamDX   RealCamDX    │
  │  │ infrastructure (stores, audit)  │                               │  │
  │  └─────┬───────────────────────────┘                               │  │
  └────────┼───────────────────────────────────────────────────────────┘
           ▼
   PostgreSQL / SQLite            Temporary artefact store (TTL sweeper)
   identity registry, auth,       id-card images, face crops, liveness
   roles, permissions, audit,     clips, face photos — handle-addressed
   records, integration settings
```

Four layers, dependencies pointing inward only: `domain` is pure (no I/O, no
framework), `services` orchestrates, `api` translates, `infrastructure` and
`integrations` reach outward. Full detail: `docs/architecture.md`.

### 2.2 Backend module map

| Directory | Responsibility | Notable modules |
|---|---|---|
| `app/api/v1/endpoints/` | HTTP + WebSocket surface | `auth`, `id_card`, `face_capture`, `verification`, `broker`, `onboarding`, `artifacts`, `records`, `integrations`, `admin`, `health` |
| `app/services/` | Application use cases | `kyc`, `documents`, `face`, `local_ocr`, `nlp_extract`, `artifacts`, `auth`, `audit`, `records`, `integrations`, `onboarding`, `identity_registry` |
| `app/domain/` | Pure rules | `requirements` (the method matrix), `verification` (status derivation), `models`, `enums`, `auth` |
| `app/infrastructure/` | Persistence | `db` (registry), `auth_store`, `audit_store`, `record_store`, `integration_store`, `liveness_link_store` |
| `app/integrations/camdx/` | Provider port | `mock/`, `verify.py`, `ocr.py`, `services/` |
| `app/schemas/` | Pydantic contracts | request/response models shared by every endpoint |
| `backend/tests/{unit,integration}` | 565 tests | domain unit, FastAPI-over-ASGI integration, scenario tests |

### 2.3 Frontend module map

| Directory | Responsibility |
|---|---|
| `app/` | route table, `AppRoutes`, authenticated layout, header |
| `pages/` | thin composition roots: `LandingPage`, `IdCardPage`, `LoginPage`, `AdminPage`, `TellerDashboard`, `CustomerDisplay` |
| `features/document-upload` | dropzone, validation, IndexedDB persistence |
| `features/id-card-processing`, `identity-form` | processing state, nine-field editing |
| `features/face-capture` | current-face capture + handle (context/provider) |
| `features/liveness` | liveness artefact handle (context/provider) |
| `features/onboarding` | dual-screen relay: `onboardingSocket`, `RemoteCameraFeed`, `RemoteFaceCapture`, `useLiveFrame` |
| `features/verification`, `report` | method selection state, result presentation |
| `features/admin`, `auth`, `records` | administration, sign-in, bulk records |
| `components/verification/` | workspace columns, identity form, method panel, field checklist, export/post/upload dialogs |
| `lib/` | `api` (typed fetch + error mapping), `session` (sessionStorage slices), `auth`, `routes` |

### 2.4 Dual-screen onboarding (the one real-time path)

One WebSocket per tab, one relay that never inspects a payload — it delivers to
the *other* role in the room (`app/services/onboarding.py`).

| Direction | Envelope | Meaning |
|---|---|---|
| teller → customer | `activateLiveness` | open the camera for a recording |
| teller → customer | `startRecording` | record 3 s (held if the camera is still opening) |
| teller → customer | `activateFaceCapture` | open the camera for a photo |
| teller → customer | `capturePhoto` | take the still now |
| teller → customer | `cancelSession` | reset: rip down, back to the welcome screen |
| customer → teller | `customerState`, `frame`, `recordingStarted`, `recordingFinished(livenessRef)`, `photo`, `error` | progress and results |
| server → room | `peerJoined` | a tab (re)connected; the teller panel re-sends its current command |

```text
Teller panel                 Relay                    Customer monitor
     │  activateLiveness ────►│──────────────────────────►│ camera opens
     │◄─── frame ×12/s ───────│◄──────────────────────────│ canvas preview
     │  startRecording ──────►│──────────────────────────►│ 3 s recording
     │◄── recordingFinished ──│◄──────────────────────────│ upload → livenessRef
     │  adopt(livenessRef)    │                           │ camera closes,
     │                        │                           │ last frame kept
```

Guard rules, all tested: the activation command is re-sent on `peerJoined` and
on panel mount **only while no artefact exists** — after a clip or a photo the
customer's camera stays closed until the teller asks again (Re-record / Retake);
the incoming `startRecording` that beats the permission prompt is held, not
refused; a taken still is copied *before* the tracks stop, so the picture stays
on the oval after the camera closes.

### 2.5 State and storage

| Store | Holds | Lifetime |
|---|---|---|
| Session cookie (opaque, 256-bit, 12 h) | sign-in | `infrastructure/auth_store` |
| PostgreSQL / SQLite tables | identity registry (D13), users/roles/permissions, audit log (append-only triggers), records, integration settings, liveness links (one usable per officer), standby display settings (one permanent room) | process lifetime; `CREATE TABLE IF NOT EXISTS` at startup, no Alembic by design |
| Temporary artefact store | id-card images, face crops, liveness clips, face photos | TTL + sweeper, handle-addressed, audited |
| Browser `sessionStorage` slices | processing result, face/liveness handles, `docStored` marker | per tab; handles are scoped to the document they came from |
| Browser IndexedDB | the uploaded document bytes | cleared on back-to-upload (D21) |

### 2.6 Security model

- Every route except `/login`, `/display` and not-found is behind sign-in
  (D18); the backend enforces the same rules independently. `401`/`403` are
  reserved for authentication/authorisation, `422` stays business validation.
- Permissions are exactly the six method ids, so the admin matrix and the
  method cards share one vocabulary; Post-to-Core additionally requires the
  full six-permission set (D19).
- `TrustedHost`, CORS and a `no-store` API middleware are installed in
  `app/main.py`; the customer display socket is public but scoped to the
  session id it was handed.
- Secrets never round-trip: integration passwords are write-only, audit
  payloads are masked at the write boundary, national IDs are truncated in the
  audit trail.

---

## 3. Libraries and plugins

### 3.1 Backend runtime (`backend/pyproject.toml`, Python `>=3.12,<3.14`)

| Package | Role |
|---|---|
| `fastapi`, `uvicorn[standard]` | HTTP + WebSocket application and server |
| `pydantic`, `pydantic-settings` | contracts, typed settings (mypy plugin active) |
| `httpx` | outbound calls — CamDX provider port, Ollama, core-system posting |
| `python-multipart` | multipart uploads (document, face, liveness clip) |
| `sqlalchemy`, `psycopg[binary]` *(extra `db`)* | identity registry and auth/audit/record stores, PostgreSQL or SQLite |
| `opencv-python-headless<5`, `numpy`, `pytesseract`, `Pillow` *(extra `vision`)* | face detection and crop, Khmer/English OCR, image normalisation |
| `pyyaml` *(extra `compose`/`dev`)* | compose contract test |

Optional external: **Ollama** (`ollama_base_url`/`ollama_model` in
`core/config.py`) for the Khmer name-split NLP path, with an offline
structural splitter as the guaranteed fallback (D24). Mock CamDX mode is the
default and the only mode tests run in.

### 3.2 Frontend runtime (`frontend/package.json`, Node `>=20.19`)

| Package | Role |
|---|---|
| `react` 19, `react-dom` 19 | UI runtime |
| `react-router-dom` 7 | route tree and guards (`RequireAuth`, `RequireAdmin`) |
| `react-day-picker` 10 | accessible calendar for the three date fields (D20) |
| `xlsx` (SheetJS) | browser-side CSV/Excel import for bulk records and xlsx/csv/json export (D17, D23) |
| `tailwindcss` 4 via `@tailwindcss/vite` | design tokens in `@theme`, no `tailwind.config.js` (D9) |
| Browser APIs, no extra library | `getUserMedia`, `MediaRecorder`, canvas frame capture, `createImageBitmap`, IndexedDB |

### 3.3 Toolchain (plugins included)

| Concern | Backend | Frontend |
|---|---|---|
| Lint | `ruff check` (E, F, I, B, UP, **S**-bandit, C4, SIM, RUF), line length 100 | `eslint` 9 flat config + `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals` |
| Format | `ruff format --check` | (prettier not used — eslint only) |
| Types | `mypy --strict` with `pydantic.mypy` plugin | `tsc --noEmit`, `typescript` 5.9 |
| Unit/integration tests | `pytest`, `pytest-asyncio` (auto mode), `pytest-cov` | `vitest` 5 + `@testing-library/react`/`user-event`/`jest-dom`, `jsdom`, `fake-indexeddb` |
| Build/run | `uvicorn`, `docker compose` | `vite` 8 (`@vitejs/plugin-react`), nginx in the container, dev proxy for `/api`, `/health`, `/ws` |
| Planned (Phase 10) | — | Playwright against the compose stack (`tests/e2e/`) |

---

## 4. Implementation plan

Status: ✅ shipped and green · 🟡 partially shipped · ⬜ open.
Phase order and the one-phase-at-a-time rule are unchanged; exit criteria for
an open phase are the work it still owes.

| Phase | Title | Status |
|---|---|---|
| 1 | Foundation | ✅ |
| 2 | Landing page / upload | ✅ |
| 3 | ID card processing | ✅ |
| 4 | Three-column workspace | ✅ |
| 5 | Verification method engine | ✅ |
| 6 | Current face capture | ✅ |
| 7 | Liveness | ✅ |
| 8 | Passport OCR | ⬜ |
| 9 | Verification report | 🟡 |
| 10 | Hardening | ⬜ |

### Phase 1 — Foundation ✅

Factory, `Settings`, redacting logs, error taxonomy, DI; `/health`,
`/api/v1/health`, `/health/ready`; React shell with routes; `docker-compose.yml`
(frontend, backend, postgres); `.env.example`, README, all `docs/`.
Exit criteria: all met (healthy compose, health payloads, proxy, green suites,
no committed secret).

### Phase 2 — Landing page ✅

`features/document-upload`: drag-and-drop + picker, §7 validation messages
verbatim, `createImageBitmap` dimension probe, object-URL revocation,
keyboard-accessible dropzone, `aria-live` region, and D21's IndexedDB
persistence so a refresh does not empty the workspace.

### Phase 3 — ID card processing ✅

TTL artefact store with opaque handles, imaging normalisation, OpenCV cascade
detection with a quality gate, Tesseract OCR producing the nine fields, the
NLP Khmer name split with low-confidence flagging (D24), empty-field semantics
(never guess), `POST /api/v1/kyc/id-card/process`. Exit criteria: met — three
§12 failure messages with distinct codes, no fabricated face, Scenario H.

### Phase 4 — Three-column workspace ✅

Document column with zoom and the face card beneath it (D14), editable nine-
field identity column, method column; responsive order per §31; no colour-only
signalling. Exit criteria: met.

### Phase 5 — Verification method engine ✅

`domain/requirements.py` as the single source, the six per-API service modules,
`MockCamDXProvider`, `GET /verification-methods`, `POST /verify` with
independent backend validation, the frontend matrix fetch, and D13's identity
registry as the comparison source. Exit criteria: met — Scenarios A and F.

### Phase 6 — Current face capture ✅

`features/face-capture` with local camera or upload, exactly-one-face gate,
handle in the session store, APIs 2 and 3 wired. Exit criteria: met —
Scenarios B, C, G (multi-face rejected, permission denial handled).

### Phase 7 — Liveness ✅

Shipped as the **dual-screen** flow rather than the §18 in-browser three-step
workflow: `app/services/onboarding.py` relay + `/ws/onboarding/{id}`, teller
`TellerDashboard`/`RemoteCameraFeed`, customer `CustomerDisplay`, clip upload
through `POST /api/broker/verify-liveness`, handle adoption into the shared
artefact slot. Since then: no preview blinking (canvas feed), the camera
stays closed after a clip, the customer screen is white with a dark-blue oval
frame and keeps the last picture, and R7 added customer-display **photo
capture** for face methods. Exit criteria: API 4 reachable only with a
completed recording, a still cannot satisfy the liveness requirement,
Scenario D; Scenario I remains open with Phase 10's end-to-end work.

### Phase 8 — Passport OCR ⬜

**Scope** §2 API 6 — `api/v1/passport`, `services/passport_ocr.py`,
`features/passport`, reachable from `/id-card/passport`.

**Exit criteria** — Scenario E (passport image → API 6 → editable passport
fields); the ID-card journey untouched; the method flips from `unavailable` to
runnable.

### Phase 9 — Verification report 🟡

**Shipped** — status derivation (`success`/`partial`/`failed`) in
`domain/verification.py`, field checklist with icon + word, section rows (D15),
in-session result accumulation (D16), export (D17), post-to-core (D19).

**Still owed** — recovery actions driven by `KycResult.actions`; a failed
state must offer an actionable next step (§27).

### Phase 10 — Hardening ⬜

**Exit criteria** — retention sweeper verified under load, artefact access
audit, log-redaction verification; HTTPS-ready config, security headers, rate
limiting on upload/verify; accessibility audit against §32; contract tests and
Playwright Scenarios A–I green against the compose stack; README verified from
a clean checkout; §37 walked item by item.

---

## 5. Quality gates

```bash
make check      # = backend-lint backend-format backend-typecheck backend-test
                #   + frontend-lint frontend-typecheck frontend-test
```

| Gate | Tool | Current |
|---|---|---|
| Backend lint/format | `ruff check`, `ruff format --check` | clean |
| Backend types | `mypy --strict` (pydantic plugin) | 75 files, no issues |
| Backend tests | `pytest` (unit + integration, mock mode forced) | 565 passed |
| Frontend lint | `eslint` (flat config, react-hooks, typescript-eslint) | clean |
| Frontend types | `tsc --noEmit` | clean |
| Frontend tests | `vitest` + Testing Library (jsdom) | 372 passed / 39 files |

Test layout and rules: `docs/testing.md`. CI and local runs use the same
targets; no test may skip.

## 6. Risk register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Real CamDX API 4 liveness contract unknown | Blocks Phase 7 | `MockLivenessProvider` + open question documented in `docs/camdx-integration.md`; no invented endpoints |
| Real CamDX response shapes unknown | Blocks normalization | Normalizer isolated in one module; mock fixtures shaped to the published spec; swap is local to that module |
| Khmer OCR field naming mismatch | Phase 3 rework | Field mapping table in `docs/camdx-integration.md`, single mapper function, unit-tested |
| OpenCV weak on printed ID-card photos | Poor extraction rate | Quality gate with actionable message; no silent fallback; Haar cascade choice documented in Phase 3 |
| Requirement-matrix drift FE ↔ BE | Wrong inputs requested | Matrix served by backend; contract test fails CI on drift |
| OpenCV on newest Python | Env friction | `pyproject.toml` pins `>=3.11,<3.14`; Docker image pinned to 3.12; `opencv-python-headless` only |
| Sensitive artefacts leaking | Compliance failure | No static mount, opaque handles, TTL sweep, log redaction — asserted by integration tests |

---

## 7. Decision log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Project root is this repository directory; it plays the role of `camdx-kyc/` in §4 | The plan document already lives here |
| D2 | Backend `domain/requirements.py` is the single source of truth; frontend fetches the matrix | §11 forbids hard-coded requirements and §19 already mandates the endpoint; a static TS mirror alone would drift |
| D3 | Internal method ids are the snake_case of the official API names (`verify_user_info`, …) | §3 forbids confusing internal renames |
| D4 | Method ids 5 and 6 (`khmer_id_card_ocr`, `passport_ocr`) are selectable verification methods because §10 lists them as such | §19's `verify` endpoint and the method selector must share one id space |
| D5 | `FaceExtraction` has no `verified`/`score` field at all | §13 requires the distinction to be structurally unbreakable, not merely documented |
| D6 | Postgres ships under compose profile `db`, unused in Phase 1 | §4: PostgreSQL only where persistence is actually required |
| D7 | PostgreSQL is not introduced until a phase needs to persist something | §29 forbids unnecessary biometric persistence |
| D8 | Artifact bytes are streamed through a short-lived endpoint rather than a static mount | §29 forbids public static exposure of sensitive files |
| D9 | Tailwind v4 via `@tailwindcss/vite` (no `tailwind.config.js`) | Current major version; less config, same result |
| D10 | Scores live on an opt-in `developerView` only | §24 permits an administrator/developer view but forbids scores in the user UI |
| D11 | Liveness is a session resource, not a single upload | §18 forbids presenting an upload as liveness |
| D12 | Local Python is 3.14 but the project pins `>=3.11,<3.14` | `opencv-python` wheels lag new CPython releases; Docker pins 3.12 |
| D13 | PostgreSQL joins the default compose stack, and verification compares the submitted identity against its sample records when `DATABASE_URL` is set (unset → fixture verification, the test default) | Supersedes D6/D7's opt-in: §4 allows persistence where application data is actually required, and the registry is the stand-in for CamDigiKey's record lookup that §26's partial results need. §29 is still honoured — no biometric data is stored, only the nine §14 text fields |
| D14 | Workspace columns reordered: the face card sits beneath the document in column 1, the identity form takes column 2, the method panel column 3 | Demonstrated reading order — the face belongs under the card it came from, the form corrects that card next, and Verify closes the row; supersedes the column order §9 was written against |
| D15 | A method's required section outcomes (face, ID card, liveness) render as rows appended beneath the nine identity fields in the same status list, not as one-off prose lines beside it | One list holds the whole report (§25); section rows carry the same icon-plus-tint-plus-word treatment as fields (§32), with "Not checked" kept neutral when `verified` is null |
| D16 | The result list accumulates within a session: identity rows always come from the latest run, a section row appears the first time a method reports that section and only refreshes afterwards, and a refused retry leaves the previous list on screen | Running "Verify User Info + User Face" after "Verify User Info" grows the shared list instead of restarting it (chosen over per-run groups or replace-on-each-run); an error may not wipe a result the user already has |
| D17 | An Export action beside "Back to upload" opens a dialog that previews every verified value, offers per-column selection defaulting to all columns, and downloads xlsx, csv or json built entirely in the browser | The file exists to move data into another system, so untouched means complete: nothing is exported only after the user removes it, and the bytes use machine forms (§14 field names, raw status enums, method id) rather than display wording |
| D18 | The whole application requires sign-in: an opaque, database-backed session cookie (seeded `admin@gmail.com` / `P4ssw0rd!`), users holding one or more roles whose permissions are exactly the six verification methods, an admin area managing accounts, roles and a permission matrix, and passwords of 8+ characters across four character classes | Requirement 5 (accounts) and requirement 7 (roles/permissions); gating every route keeps per-method permissions enforceable before the first request, permission keys equal method ids so the matrix and the method cards share one vocabulary (§10), opaque tokens beat JWTs here because disabling an account or signing out must take effect on the next request rather than after a token lifetime, 401/403 are reserved for authentication/authorisation while 422 stays business validation (§28), and the policy is one sentence so no rule leaks a different hint |
| D19 | Third-party integration, shipped in five committed increments (requirement 9): a "Post Settings" dialog (gear, workspace header) manages the core systems that receive results — URL, API user and password, saved as one replace-all list where a blank password on an existing row keeps the stored one — and "Post to Core Systems" under a new "Verification Response" heading replays the current verification response to each system with HTTP Basic, answering one `200 {posted, failed[]}` with fixed safe reasons; both controls and all three routes require the full six-permission set | The credentials must be replayed to the target, so they are stored recoverably in the auth database yet never returned by any endpoint (§29) nor echoed in errors (§28); gating on the permission set rather than `is_admin` matches the seeds exactly (Admin and Senior Loan Officer hold all six, a Loan Officer two) without naming roles in code; a per-target report beats failing the whole post when one of several systems refuses, and "nothing configured" alone is a `400` so an empty success cannot masquerade as delivery |
| D20 | The three date fields render through a calendar datepicker: a labelled control still takes typed `YYYY-MM-DD` (digits and dashes only; partial or impossible values clear on blur) while an icon button opens a react-day-picker calendar whose pick writes the same ISO string; the library owns the WAI-ARIA grid, arrow/Home/End/PageUp/PageDown movement and month navigation, branded with CSS custom properties and a few cascade-safe rules | The native picker varies by platform and cannot match the design (§32); react-day-picker is the most-downloaded maintained option (≈56M weekly installs against ≈6M for react-datepicker), WCAG 2.1 AA, React 19 compatible and Tailwind-stylable, so the accessibility-hard part ships tested while the field keeps the typing contract every consumer and test relies on |
| D21 | The uploaded document survives a page refresh: its bytes live in IndexedDB while `sessionStorage` keeps only a `docStored` marker that first paint reads to show "Restoring your session…" until the async load lands; the processing result and the captured face keep their existing small slices, and back-to-upload clears everything | The ~5 MB `sessionStorage` quota cannot hold the 10 MB uploads validation allows (~13 MB as base64), so the old write failed silently and a refresh emptied the workspace — the captured face with it, since the face only renders inside a document-bearing session; IndexedDB has no such bound and never leaves the device, which is what the landing page promises; the marker exists because IndexedDB has no synchronous read, and every marker write is synchronous with its own action so a background completion cannot write into storage cleared in the meantime, while a marker without bytes heals to the empty state |
| D22 | "Post Settings" gains a per-system "Test Connection": each row probes its URL and Basic-auth credentials exactly as typed — a blank password on a saved row uses the stored credential, the rule a save keeps — with a fixed body carrying no subject data, answering `200 {ok, reason}` in the post's four fixed safe sentences; malformed input is the only `400`, and the route sits behind D19's six-permission gate | The configuration must be shown to work before it is saved, and testing the draft rather than the stored list keeps save and test from disagreeing about which password is in play; sharing the post's HTTP Basic, timeout and reason words (§28) means the probe predicts the real post instead of testing something else, while the fixed body keeps personal data from leaving before the admin has chosen to save (§29) |
| D23 | Bulk verification data arrives through an "Upload" button on the Identity Verification landing page: a three-step dialog (file, map fields, review) parses the CSV or Excel in the browser with the `xlsx` library that already writes the exports, pairs its columns with the nine §14 fields through a mapping saved as the one reusable default and re-applied when the next file's columns line up, and submits only the mapped values — never the file — to a new `/api/v1/records` API behind `current_user` rather than D19's six-permission gate; the records list sits below the workspace with server-side search, status filter, page size and paging, "Start" copies a row into the existing identity form regardless of whether a document is in session (the method's own requirement flags still decide what may run), and a completed run stores its `VerifyResponse` on the record so the Status column flips to "Verified" and Preview reopens the outcome | A spreadsheet is where bulk applications live, but only its values are verification data: parsing client-side keeps file bytes, headers and unmapped columns from ever reaching the server (§29), while storing rows server-side keeps the list and a record's verified state alive across refreshes and sessions, which a browser-only list would lose; one default mapping rather than named ones mirrors the single posting-settings row — the common case is one house template, and the mapping step stays visible so a mismatched file can always be remapped by hand; an authenticated gate matches `POST /verify`, which already lets a Loan Officer handle one identity at a time, so requiring all six permissions here would block exactly the users the feature exists for; populating the form "regardless of document" reuses §14, §16 and §11 untouched — the row supplies what OCR would have, so no second verification path is invented |
| D24 | The Khmer name split runs through NLP: the Ollama prompt carries the card's style — the `ឈ្មោះ/Name` run prints the given name first and the family name last, the Latin line beneath repeats that order — and only intact Khmer words may enter a name slot, with an offline structural splitter (same order, digit/Latin noise dropped) covering Ollama being off or failing; beside it, a field whose own Tesseract words read below confidence 60 renders with a red input tint and a "Verify this field" prompt, while an empty field keeps §16's own prompt | The card prints both Khmer names on one line with no label between them, so keyword labels cannot say which token is the family name and OCR garbles the run into noise including the row's label — the analysis is the understanding step this module's NLP path always promised, and the offline split answers the same way when no model is reachable; §16's honesty extends from "not read" to "read but doubted": a capture the engine itself scored in the 20s shown as a plain value would be a quiet guess, and the paired prompt keeps the tint from carrying meaning by colour alone (§32) |
| D25 | Every action that touches an identity leaves an append-only audit entry: `audit_logs` records an epoch timestamp, the staff id/email/role, one of four action types (`CAMDX_FETCH`, `IDENTITY_VERIFIED`, `MANUAL_APPROVED`, `POST_TO_CORE`), the target system URL, a payload snapshot masked before the store ever sees it, the biometric confidence score when a run produced one, and a `PENDING`/`SUCCESS`/`FAILED` status with the error body a failure captured — the table is enforced append-only by triggers installed idempotently at startup (SQLite `RAISE(ABORT)` and a PostgreSQL plpgsql twin: DELETE always refused, UPDATE only the single status transition on the outcome columns); "Post to Core" writes two-phase — a `PENDING` row commits before the outbound call, so no audit means no post, and is finalized best-effort after it, while a verification records `IDENTITY_VERIFIED` once, born terminal; national IDs keep only their first three and last two digits (their `submitted` sibling with them) and secret keys are replaced wholesale, all at the write boundary; `GET /api/v1/admin/audit-logs` — admin-only, staff/action/status/date-range filters, limit and offset paging — feeds a read-only "Audit trail" tab on the Administration page whose rows expand to the stored evidence | Maker-Checker needs evidence nobody, administrator included, can rewrite after the fact, so immutability belongs to the database rather than to an API that simply omits DELETE; the outcome lives in `status` so the action vocabulary stays four stable words while a failed post remains unmistakable, and a row left `PENDING` after a crash is itself the signal of an interrupted call — writing the entry only after the HTTP response would lose exactly the failures worth auditing, which is why the begin is fail-closed and the finalize is best-effort; masking at the write boundary lets the trail be shown in full without §29 exposure and without a read path that must remember to redact, while §28 keeps the post endpoint's own failure reasons to its four safe words with the real evidence held behind the admin gate; epoch timestamps follow the repo's portability rule, biometric scores stay NULL when no liveness ran rather than being invented, and the tab renders without waiting on the roles and permissions lists because the trail belongs to no tab but its own

| D26 | The customer monitor is reached through **per-customer liveness links** instead of one fixed page: the workspace header's "Liveness Links" button (every signed-in officer, not only administrators) opens a dialog that mints a link for a named customer — token generated once behind `?session=`, an expiry chosen from 1 h / 4 h / 8 h / 24 h / 7 d presets or a custom date-time, never edited or rotated afterwards — while `GET`/`POST /api/v1/onboarding/liveness-links` list the officer's rows newest first (expired ones kept, grouped by customer) and mint one, a new mint setting `supersededAt` on the previous so exactly one link per officer is usable; the server derives `in_use`/`superseded`/`expired` per request from the two timestamps, rejects a past `expiresAt` with `400 INVALID_REQUEST` and `error.fieldErrors`, and never hands out another officer's token (`token: null`, `scope=all` administrator-only metadata); the relay accepts the WebSocket handshake and *then* closes `4404` unknown room, `4410` expired, `4411` superseded, `4403` not the owner, which the customer screen and the teller panels each turn into one plain sentence | The fixed page was all-or-nothing for everybody and its permanent URL never expired, so a link handed to one customer went on working after the application it belonged to had ended; a per-customer token gives each application an address that dies on schedule, and the supersedes rule makes a stale URL stop rather than quietly outlive the new one — which is also why there is no update route: a token that cannot be rewritten is one that cannot drift from the row it was issued for; deriving status instead of storing it keeps a restart from lying about expiry, keeping expired rows answers a returning customer by name instead of by memory of which URL worked, redacting other officers' tokens keeps the read path free of §29 exposure, and a close code after `accept` is the only signal a socket can carry — a refusal *before* `accept` would leave the peer unable to tell "expired" from "not there" |

| D27 | The customer monitor is reachable two ways and the dialog says which: the **standby screen** returns as one global room (`liveness_display_settings`, `GET`/`PUT /api/v1/onboarding/liveness-page`) whose token is minted once and never rewritten, so the URL pasted on the counter monitor survives redeploys, reloads and every toggle, with a switch any signed-in officer may flip and a room that has no owner, no expiry and no supersession — while **unique links** keep every rule D26 gave them; the Liveness Links dialog gains a "Screen to drive" choice (Standby screen / Unique link) stored per browser in `localStorage`, and the teller panels (`RemoteCameraFeed`, `RemoteFaceCapture`, `TellerDashboard`) join whichever room it names, re-joining when the choice changes, with the standby socket refused as `4412` while the screen is off | The counter case and the remote case are different jobs: a customer sitting down should not wait for a URL to be minted and read out, while a customer who is not in the room cannot open a URL that only exists on this screen — one permanent standby URL plus per-customer links covers both without either having to pretend to be the other. The choice lives in the browser because it describes that counter's screen rather than the officer's account, and it defaults to `unique` so an installation that has never seen the dialog keeps behaving exactly as D26 shipped it. `4412` rather than `4404` because "you had this and it is off now" is a different instruction from "that never existed", and the standby row sits beside the links table instead of inside it — a room must not inherit an expiry, a supersedes rule or an owner it was deliberately built without |
