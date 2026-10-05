# Testing Guide

Three levels, per §34.

---

## 1. Layout

```text
backend/tests/
├── conftest.py                 forces CAMDX_MODE=mock, DATABASE_URL='' (fixtures), temp storage isolation
├── unit/                       pure domain — no I/O, no network
│   ├── test_config.py
│   ├── test_errors.py
│   └── test_logging_redaction.py
└── integration/                FastAPI over ASGI transport
    └── test_health.py

frontend/src/**/*.test.ts(x)    Vitest + Testing Library

tests/
├── contract/                   cross-boundary drift guards
├── e2e/                        Scenarios A–I (Playwright, Phase 10)
└── fixtures/                   synthetic images, sanitised payloads
```

---

## 2. Rules

1. **No test contacts the real CamDigiKey service.** `conftest.py` forces
   `CAMDX_MODE=mock` and asserts it. It also forces `DATABASE_URL=''` so
   verification runs on bundled fixtures — no test needs a database (D13).
2. **Domain unit tests import no I/O module.** No `httpx`, no `cv2`, no FastAPI.
   A test that needs any of them belongs in `integration/`.
3. **No real documents in Git.** Fixtures are generated synthetically.
4. **Every phase ships its tests.** A phase is not done until its tests are green.
5. **No skipped tests.** A test that cannot run is deleted, not skipped.
6. **Deterministic outcomes.** Mock results are selected by documented trigger
   codes, never by randomness (`docs/camdx-integration.md` §3).
7. **The authentication gate is switched off for everything except the tests
   that test it** (D18). Backend: `conftest.py` forces `AUTH_ENABLED=false`, so
   `current_user` answers with the development superuser and the ~350 tests
   written before accounts exist keep their meaning; `auth_client` and
   `test_auth.py` / `test_admin_accounts.py` re-enable it per-test against a
   temporary SQLite store. Frontend: `src/test/setup.ts` seeds a signed-in
   administrator into auth storage before every test (the whole app is gated),
   and the auth tests clear or replace that profile themselves.

---

## 3. Level 1 — Unit

Targets, per §34:

| Target | Module | Phase |
|--------|--------|-------|
| OCR field mapping | `integrations/camdx/services/idcard_ocr.py` | 3 |
| Face detection service | `services/face_service.py` | 3 |
| Verification requirement rules | `domain/requirements.py` | 5 |
| Six-adapter registry | `integrations/camdx/services/__init__.py` | 5 |
| CamDX response normalization | `integrations/camdx/normalizer.py` | 5 |
| Error mapping | `integrations/camdx/errors.py` | 5 |

Deliberate properties:

- **An unchecked field is never reported as a mismatch.** If CamDX omits DOB, the
  normalized result must not list DOB in `incorrectFields`.
- **A missing identity value stays missing.** The OCR mapper never substitutes a
  default, a placeholder, or a plausible-looking value (§16).
- **Face extraction yields no verification claim.** Asserted structurally: the
  `FaceExtraction` type has no `verified` attribute (§13).
- **No upstream text escapes.** Every mapped error case asserts its message
  contains no vendor code, endpoint, or status line (§28).

Phase 1 ships `test_config`, `test_errors`, `test_logging_redaction`.

---

## 4. Level 2 — Integration

Exercises the real application over ASGI transport with `MockCamDXProvider`:

```text
POST /api/v1/kyc/id-card/process
      → OCR fields + face extraction + artefact handles
GET  /api/v1/kyc/verification-methods
      → all six methods with their requirement flags
POST /api/v1/kyc/verify
      → CamDX mock → normalized result
```

Plus the standing privacy assertions (§29):

- No route exposes uploaded files through a static mount
- Artefact bytes are reachable only via the artefact endpoint
- Log output contains no national ID and no image bytes
- An expired handle returns `404`, not the file

Each integration test gets an isolated `TEMP_STORAGE_DIR`; artefacts never leak
between tests.

---

## 5. Level 3 — End-to-End

Playwright against the Docker Compose stack. Scenarios A–I from §34.

| Scenario | Flow | Phase |
|----------|------|-------|
| A | ID Card → OCR → API 1 → success | 5 |
| B | ID Card → OCR → current face → API 2 → success | 6 |
| C | ID Card → OCR → current face → API 3 → success | 6 |
| D | ID Card → OCR → liveness → API 4 → success | 7 |
| E | Passport → API 6 → OCR | 8 |
| F | Incorrect identity information → partial / failure | 5 |
| G | Face mismatch → failure | 6 |
| H | No face detected → processing failure | 3 |
| I | Liveness failure → verification failure | 7 |

Each scenario asserts three things beyond the happy path:

1. The user-facing message is the §25/§26/§27 wording, not a generic error.
2. No raw JSON appears anywhere in the DOM.
3. The state machine refuses the illegal transition rather than proceeding.

---

## 6. Running

```bash
make check                                  # lint + typecheck + all unit/integration
cd backend && pytest -v
cd frontend && npm run test

# Phase 10
docker compose --profile e2e up -d
npx playwright test
```

---

## 7. Phase 1–4 status

| Suite | Result |
|-------|--------|
| `backend/tests/unit` | config, errors, logging redaction, artifacts, face rules, uploads, mock OCR, document orchestration |
| `backend/tests/integration` | health, compose env contract, upload-rules contract, ID-card endpoint, verification endpoints, artefact sweeper |
| `frontend` | Vitest; validation, dropzone, session persistence, landing page, API client, workspace columns (document, face, editable form), verification method panel |
| `make check` | ruff, ruff format, mypy, pytest, eslint, tsc, vitest all green |
| Docker | `docker compose up --build` healthy on both services; app (:8000) and frontend (:3000) report healthy; `/`, `/health`, `/api/v1/health` → `200` through the nginx proxy and direct; processing and artefact endpoints exercised over HTTP |

`314 passed` backend, `99 passed` frontend.

### What the workspace tests pin down

Each column is asserted against the section of the plan that specifies it, so a
layout change cannot quietly drop a requirement:

| Requirement | Guard |
|-------------|-------|
| §9 column 1 shows the uploaded file | preview `src` points at `documentRef`, not `faceRef` |
| §9 zoom | transform goes 100% → 150%; zoom-out disabled at origin |
| §12 no-face / multiple / poor-quality | all three sentences asserted **verbatim**, not by keyword |
| §12 do not fabricate a face | no `img` present when detection failed |
| §13 detection ≠ verification | OpenCV is named, and no `verified` text anywhere on the page |
| §14 nine fields, in order | label list asserted by equality against `IDENTITY_FORM_FIELDS` |
| §14 all fields editable | every input enabled, including ones OCR already read |
| §14 corrections persist | edit survives re-render; clear is honoured as a correction |
| §14 no cross-card leakage | corrections are dropped when a different card is processed |
| §25 section outcomes in one list | required sections append as rows beneath the nine fields; "Not checked" stays neutral |
| one shared list (D16) | face method after API 1 keeps the nine rows and appends the face row; a refused retry keeps the previous list |
| export defaults to all columns (D17) | untouched dialog downloads every column in all three formats; deselecting drops exactly that key; disabled with none left |
| posting gate + write-only passwords (D19) | Loan Officer receives 403 on every integrations route and sees no Post buttons; settings responses never contain a stored password; a blank password on save keeps the stored one (checked against the store); a refused save leaves the list untouched |
| §16 unread field | empty input plus "Please enter this information." |

### Why the face tests do not use a photograph

`FaceService` takes a `FaceDetector`. The rules — one face only, clear enough to
use, crop it and store it — are tested through a scripted detector
(`tests/fixtures/detectors.py`), so they are deterministic and do not depend on a
statistical model.

A Haar cascade is trained on photographs. It is sensitive to `scaleFactor` in a
way that is not a property of this application: a synthetic drawing detected at
`scaleFactor=1.05, minNeighbors=1` and not at `1.1/1.2`, and `minNeighbors=1` is far
too permissive for production because it fires on background texture — a false
positive would hand the user a crop of something that is not their face. Asserting
a face count against a drawing would be testing the cascade, and would break on an
OpenCV upgrade.

So one integration test runs the real cascade and asserts only that a valid
outcome comes back, never how many faces were found.

### Why `TestClient` appears in the sweeper test

The shared `client` fixture uses `ASGITransport`, which does **not** run lifespan
events. The artefact sweeper is created in the lifespan, so a test using that
fixture cannot observe it — and `TempArtifactStore.sweep` passes on its own whether
or not the background loop was ever started. `test_artifact_sweeper.py` uses
`TestClient` for exactly that reason.

### Cross-boundary contract tests

Two rules are implemented twice, once in TypeScript for the browser and once in
Python for the server, and both silently win over each other depending on where
the value comes from:

- **Upload rules.** `test_upload_rules_contract.py` reads the browser's constants
  and compares them with `Settings`, `.env.example` *and* `docker-compose.yml`.
  The last two matter because either can restate a limit and override the model
  default, so container behaviour diverges from local development with no error.
  The user's four upload messages are asserted to be byte-identical in both
  layers.
- **Container environment.** `test_compose_env_contract.py` checks every `Settings`
  field is forwarded by compose, and that compose forwards nothing `Settings`
  does not know about.

E2E (Scenarios A–I) arrives with the phases that make each flow possible —
A and F in Phase 5, H in Phase 3, and so on. They are not written before the
feature they exercise exists.
