# Implementation Plan

Derived from `camdx_execution_plan.md` §36. Phase order is preserved; each phase
carries an explicit exit criterion that must be demonstrated before the next
phase starts (§38).

---

## Rules of execution

1. One phase at a time. No later phase is implemented until the current phase's
   acceptance is demonstrated.
2. No unresolved errors at phase exit — a failing check is fixed, not deferred.
3. Tests are written in the same phase as the code they cover.
4. No requirement is silently altered. A change is a documented decision in this
   file under "Decision log".
5. CamDX behaviour is never invented. Where the real contract is unknown, the
   seam is isolated behind `CamDXProvider` and the unknown is listed in
   `docs/camdx-integration.md` as an open question.
6. Mock and real implementations never share a code path.

---

## Phase 1 — Foundation ✅ (current)

**Scope**

- Git repository, `.gitignore`, `.editorconfig`
- `docker-compose.yml` (backend, frontend, optional postgres profile — later the
  default stack, D13)
- `backend/` FastAPI app: factory, `Settings`, structured logging with redaction,
  error taxonomy, DI container
- `GET /health` and `GET /api/v1/health` — liveness + readiness
- `frontend/` React 19 + TypeScript + Vite + Tailwind v4 + React Router shell
  with the two route targets (`/`, `/id-card`) as placeholders
- `.env.example`, README, all `docs/`
- Backend unit + integration tests, frontend build and test config

**Exit criteria (§36)**

- [x] `docker compose up --build` reaches healthy state
- [x] `GET /health` → `200 {"status":"ok"}`
- [x] `GET /api/v1/health` → `200` with version, mode, environment
- [x] Frontend serves and `/id-card` resolves (no route fallback to 404)
- [x] `pytest` green, `ruff` clean, `mypy` clean
- [x] `tsc --noEmit` clean, `vitest` green, `vite build` succeeds
- [x] Frontend dev server proxies `/api` to the backend
- [x] No secret is committed; `.env` is git-ignored

**Deliberately excluded from Phase 1** — these are Phase 5 constructs and only
their directories exist: `app/domain/requirements.py`, `app/integrations/camdx/*`,
`app/services/kyc_service.py`. Phase 1 validates the *seams*, not the features.

---

## Phase 2 — Landing Page

**Scope** §6, §7, §31

- `features/document-upload`: drag-and-drop + file picker, client-side validation
  (type, size, readability, minimum resolution) with the exact messages in §7
- Image decode/dimension probe in the browser (`createImageBitmap`)
- Object-URL preview with revocation on replace/unmount
- Route to `/id-card`, carrying the upload through a session store
- Keyboard-accessible dropzone, `aria-live` status region
- Mobile-first layout, tablet/desktop breakpoints

**Exit criteria**

- User can upload a valid JPG/PNG/WebP by click or drag and land on `/id-card`
- Each §7 rejection message appears verbatim and accessibly
- Oversized, non-image, unreadable and low-resolution files are all rejected client-side
- Preview never leaks a blob URL into the console
- Component tests cover each validation branch

---

## Phase 3 — ID Card Processing

**Scope** §12, §15, §16, §29

- `infrastructure/storage.py`: TTL temp artifact store with opaque handles
- `infrastructure/imaging.py`: decode, size/resolution gate, normalise, thumbnail
- `services/face_service.py`: OpenCV cascade detection, bbox, crop, quality gate
- `services/document_service.py`: store → CamDX Khmer ID OCR → face extraction
- `MockCamDXProvider` OCR (API 5) returning realistic Khmer/English field pairs
- `POST /api/v1/kyc/id-card/process`
- Empty-field semantics: never guess, never fabricate (§16)

**Exit criteria**

- Upload yields extracted identity fields **and** an extracted face
- §12's three failure messages reproduced exactly, each with a distinct code
- No face is ever fabricated; a failed detection returns a failure, not a blank crop
- Artefacts are reachable only through handles and are swept after TTL
- Scenario H (no face detected) passes end-to-end
- Local OpenCV result is labelled as detection, never verification (§13)

---

## Phase 4 — Three-Column Workspace

**Scope** §8, §9, §12, §14, §31

- Column 1: original document preview with zoom, filename, processing status,
  replace
- Column 2: extracted face with a persistent "local detection — not a verification"
  notice (§13)
- Column 3: editable identity form — all nine fields from §14, OCR-uncertain
  fields flagged, empty fields prompting "Please enter this information."
- Desktop 3-col / tablet 2-col / mobile stacked order per §31

**Exit criteria**

- Every extracted value is present and editable; edits survive method changes
- Mobile order is exactly §31's six steps
- Keyboard reaches every control in a sensible order
- No colour-only signalling; status uses icon + text (§32)

---

## Phase 5 — Verification Method Engine

**Scope** §10, §11, §19, §20, §21, §23, §33

- `domain/requirements.py` requirement matrix (authoritative)
- `domain/state_machine.ts` equivalent + `domain/results.py`
- `integrations/camdx/`: provider port, factory, client, models, exceptions,
  error mapper, normalizer, and the six per-API service modules
- `MockCamDXProvider` covering all six APIs with deterministic outcomes
- `GET /api/v1/kyc/verification-methods`, `POST /api/v1/kyc/verify`
- `services/kyc_service.py`: independent backend requirement validation
- Frontend method selector driven by the fetched matrix

**Exit criteria**

- Each method asks only for its own inputs
- `POST /verify` with missing inputs → `422 REQUIREMENTS_NOT_MET` naming the fields,
  even if the frontend was bypassed
- Frontend TS mirror ≡ API response (contract test green)
- Raw CamDX payload never appears in any response body
- Scenario A (ID Card → OCR → API 1 → success) passes
- Scenario F (wrong identity → partial/failure) passes

---

## Phase 6 — Current Face Capture

**Scope** §17

- `features/face-capture`: `getUserMedia` capture and file upload
- Exactly-one-face gate using the same detector as Phase 3
- Retake / remove / replace, preview, verification locked until valid
- APIs 2 and 3 wired through the provider

**Exit criteria**

- API 2/3 requests are rejected without a valid current face, at both layers
- Multi-face current photos are rejected with a clear message
- Camera permission denial is handled gracefully
- Scenarios B, C and G pass

---

## Phase 7 — Liveness

**Scope** §18

- `features/liveness`: 3-step workflow (turn left → turn right → nod), progress,
  camera preview, per-step capture status
- Liveness session resource in the backend: start → submit action → complete
- `MockLivenessProvider`, clearly isolated, replaceable by the real implementation
- API 4 adapter

**Exit criteria**

- API 4 is unreachable without a completed liveness session
- Uploaded stills cannot satisfy the liveness requirement
- A failed action produces the §27 failure message and a retry affordance
- Scenario D and Scenario I pass

---

## Phase 8 — Passport OCR

**Scope** §2 API 6

- `api/v1/passport`, `services/passport_ocr.py`, `features/passport`
- Independent of the ID-card flow

**Exit criteria**

- Scenario E passes: passport image → API 6 → editable passport fields
- The ID-card journey is untouched by this feature

---

## Phase 9 — Verification Report

**Scope** §24, §25, §26, §27

- `features/report`: success / partial / failed presentations
- Only relevant sections render (API 1 shows no face section)
- Field-level matched/mismatched rows, green check icons, non-colour cues
- Recovery actions driven by `KycResult.actions`

**Exit criteria**

- Scenario C reports identity + face + ID card; Scenario A reports identity only
- No raw JSON, endpoint, HTTP status or score anywhere in the DOM
- Partial results list exactly the mismatching fields
- Every failure state offers an actionable next step (§27)

---

## Phase 10 — Hardening

**Scope** §29, §30, §32, §34, §35, §37

- Retention sweeper, artefact access audit, log redaction verification
- HTTPS-ready config, security headers, rate limiting on upload/verify
- Full accessibility audit against §32
- Unit + integration + E2E suite green; Scenarios A–I all passing
- Documentation complete and accurate; README verified against a clean checkout
- §37 checklist walked item by item with evidence

---

## Risk register

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

## Decision log

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
