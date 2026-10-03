# Architecture

> CamDX KYC Verification Application — architecture definition.
> This document is the authority for module boundaries, dependency direction and
> the mapping between product actions and the six CamDigiKey APIs.

---

## 1. System context

```text
┌────────────────────────┐
│      React SPA         │   Browser. Talks ONLY to our backend.
│  (no CamDX secrets)    │
└───────────┬────────────┘
            │ HTTPS / JSON / multipart
            ▼
┌────────────────────────┐
│   FastAPI Application  │   Application Layer (§5)
│   /api/v1/...          │
└───────────┬────────────┘
            │
   ┌────────┼──────────┬──────────────────┐
   ▼        ▼          ▼                  ▼
┌────────┐ ┌────────┐ ┌───────────────┐ ┌──────────────────────┐
│Document│ │ Face   │ │ KYC Service   │ │ Requirement Engine   │
│Service │ │ Service│ │ (orchestrator)│ │ (single source truth)│
└───┬────┘ └───┬────┘ └───────┬───────┘ └──────────────────────┘
    │          │              │
 CamDX      OpenCV      CamDXProvider (port)
   OCR    (detection)         │
    │          │      ┌────────┴────────┐
    │          │      │                 │
    │          │  MockCamDXProvider  RealCamDXProvider
    │          │      │                 │
    │          │      └────────┬────────┘
    │          │               │
    ▼          ▼               ▼
┌──────────────────────────────────────────┐
│            CamDigiKey KYC APIs           │
└──────────────────────────────────────────┘
```

The browser **never** contacts CamDigiKey. Credentials exist only in the backend
process environment (§30).

---

## 2. Layering and dependency direction

Dependencies point **inward only**. A layer may import the layer directly below it
and nothing above it.

| # | Layer | Package | May import | Never does |
|---|-------|---------|-----------|-----------|
| L1 | Presentation | `app/api`, `app/schemas` | L2 | call OpenCV/httpx directly |
| L2 | Application | `app/services` | L3, L4 | build provider-specific payloads |
| L3 | Domain | `app/domain` | stdlib only | perform I/O, read settings |
| L4 | Adapters | `app/integrations`, `app/infrastructure` | L3 | contain product rules |

```text
app/api  ──────────►  app/services  ──────────►  app/domain
                            │                        ▲
                            ▼                        │
              app/integrations/camdx  ───────────────┘
              app/infrastructure
```

`app/domain` is pure: no FastAPI, no `httpx`, no OpenCV, no settings. This is
what makes the requirement engine (§11) and the state machine (§33) unit-testable
without mocks.

---

## 3. Backend module map

| Module | Phase | Responsibility |
|--------|-------|----------------|
| `app/main.py` | 1 | App factory, middleware wiring, router registration, lifespan |
| `app/core/config.py` | 1 | `Settings` (pydantic-settings), env parsing/validation |
| `app/core/logging.py` | 1 | JSON logs + PII/biometric redaction filters |
| `app/core/errors.py` | 1 | `AppError` taxonomy, error codes, exception handlers |
| `app/core/ids.py` | 1 | Opaque handle/request-id generation |
| `app/api/deps.py` | 1+ | Dependency-injection providers (settings, services) |
| `app/api/v1/endpoints/health.py` | 1 | Liveness + readiness probes |
| `app/api/v1/endpoints/kyc.py` | 3+ | `id-card/process`, `verification-methods`, `verify` |
| `app/api/v1/endpoints/liveness.py` | 7 | Liveness session + action endpoints |
| `app/api/v1/endpoints/passport.py` | 8 | Passport OCR endpoint |
| `app/domain/enums.py` | 1 | `VerificationMethod`, `VerificationStatus`, `WorkflowState` |
| `app/domain/requirements.py` | 5 | Requirement matrix — single source of truth |
| `app/domain/identity.py` | 3 | `KhmerIdentity`, `PassportIdentity` value objects |
| `app/domain/state_machine.py` | 5 | Explicit legal transition table |
| `app/domain/results.py` | 5 | Normalized `KycResult` (§23) domain model |
| `app/services/document_service.py` | 3 | ID-card pipeline: store → OCR → face → result |
| `app/services/face_service.py` | 3 | OpenCV detect / crop / quality gate (§12) |
| `app/services/kyc_service.py` | 5 | Validates requirements, dispatches provider, normalizes |
| `app/infrastructure/storage.py` | 3 | TTL temp artifact store, opaque handles (§29) |
| `app/infrastructure/imaging.py` | 3 | Decode, validate, normalise, thumbnail |
| `app/integrations/camdx/provider.py` | 5 | `CamDXProvider` port + factory (§21) |
| `app/integrations/camdx/client.py` | 5 | Auth, retry, timeout, idempotency (real mode) |
| `app/integrations/camdx/models.py` | 5 | Raw upstream request/response shapes |
| `app/integrations/camdx/errors.py` | 5 | Upstream error → business code mapping (§28) |
| `app/integrations/camdx/normalizer.py` | 5 | Raw response → normalized result (§23) |
| `app/integrations/camdx/services/*.py` | 5–8 | One module per official API (§20) |
| `app/integrations/camdx/mock/*` | 3–7 | `MockCamDXProvider`, `MockLivenessProvider` (§18) |
| `app/infrastructure/db.py` | later | SQLAlchemy — only if persistence is required |

### 3.1 The six official API modules (§20)

Each module wraps exactly one CamDigiKey API and owns its payload shape:

| File | Official API |
|------|--------------|
| `services/verify_user_info.py` | API 1 — Verify User Info |
| `services/verify_user_face.py` | API 2 — Verify User Info + User Face |
| `services/verify_user_idcard_face.py` | API 3 — Verify User Info + ID Card + User Face |
| `services/verify_user_liveness.py` | API 4 — Verify User Info + ID Card Image + Liveness |
| `services/idcard_ocr.py` | API 5 — Khmer ID Card OCR |
| `services/passport_ocr.py` | API 6 — Passport OCR |

---

## 4. Requirement engine (§11)

**Single source of truth: `backend/app/domain/requirements.py`.**

```python
@dataclass(frozen=True)
class MethodRequirement:
    method: VerificationMethod
    requires_user_info: bool
    requires_current_face: bool
    requires_id_card: bool
    requires_liveness: bool
    requires_passport: bool
```

Drift control:

```text
        requirements.py  (authoritative)
                 │
                 │  GET /api/v1/kyc/verification-methods
                 ▼
      frontend/src/features/verification/methods.ts
                 │
                 │  tests/contract/test_requirement_contract.py
                 ▼
        CI fails if the TS mirror drifts
```

The frontend consumes the matrix at runtime via §19's
`GET /api/v1/kyc/verification-methods`. A TypeScript mirror exists only so the UI
can typecheck; `tests/contract/` asserts mirror ≡ API response, so drift is a
test failure rather than a production bug.

**Enforcement is duplicated by design** (§11, §46 of the product intent):
the frontend disables the Verify button; the backend independently re-derives the
same requirements and rejects under-specified requests with `422 REQUIREMENTS_NOT_MET`.

---

## 5. Face detection vs face verification (§13)

These are separate capabilities and are modelled as separate types so they can
never be conflated in the UI.

| Concern | Owner | Type | Presented to user as |
|---------|-------|------|----------------------|
| Extract face region from ID card | `FaceService` (OpenCV, local) | `FaceExtraction` | "Face extracted from ID Card" + explicit *not a verification* note |
| Match ID-card face vs current face | CamDigiKey (API 2/3) | `FaceVerificationOutcome` | "Face verified by CamDigiKey" |

Rules encoded in the architecture:

- `FaceExtraction` has **no** `verified`, `matched` or `score` field. It physically
  cannot be rendered as a verification result.
- The only source of a `face.verified` claim is the normalizer, from a CamDX
  response.
- `KycResult.face.source` is one of `not_required | camdx`. Local detection never
  sets it to `camdx`.
- §13's message separation is reflected in the DTO: extraction lives in
  `IdCardProcessResponse.face`, verification lives in `KycResult.face`.

---

## 6. Normalized result (§23)

```text
CamDX raw response
      │
      ▼  integrations/camdx/normalizer.py   (only place that knows raw shapes)
KycResult (domain)
      │
      ▼  api/schemas/results.py
KycResultResponse (transport)
      │
      ▼
React report components
```

```text
KycResultResponse
├── verificationId, method, methodLabel, status
├── identity   { required, matched, checkedFields[], incorrectFields[] }
├── face       { required, verified, source, statusLabel }
├── idCard     { required, verified, statusLabel }
├── liveness   { required, verified, statusLabel }
├── ocr        { documentType, statusLabel, extractedFields[] }
├── message
├── actions[]  { id, label, kind }   ← drives the UI's recovery buttons
└── requestId
```

Raw scores, endpoints, HTTP status and upstream error text are **not** in the
transport DTO. They live on `developerView`, an optional field omitted unless
`CAMDX_EXPOSE_DEVELOPER_VIEW=true` (§24).

---

## 7. Error translation (§28)

```text
httpx / upstream error
   → integrations/camdx/exceptions.py   (typed upstream errors)
   → integrations/camdx/errors.py       (upstream code/reason → business code)
   → core/errors.py                     (business code → HTTP status + safe message)
   → api error envelope                  { error: { code, message, fieldErrors, requestId } }
   → React toast / inline field error
```

No layer above `core/errors.py` may emit a raw upstream string. Enforced by
`tests/unit/test_error_mapping.py`, which asserts no upstream payload text
reaches a response body.

Error codes are business nouns — `IDENTITY_NOT_VERIFIED`, `FACE_NOT_VERIFIED`,
`FACE_NOT_DETECTED`, `LIVENESS_FAILED`, `OCR_UNREADABLE` — never
`HTTP_500` or upstream vendor codes.

---

## 8. Privacy architecture (§29)

```text
Upload bytes ──► validate in memory ──► TempArtifactStore
                                            │
              var/tmp/<opaque-handle>       │  never under a static mount
              TTL sweep (Phase 3)          │  deleted automatically
                                            │
              served to browser ONLY via a
              short-lived authenticated
              artifact-stream endpoint
              (returns bytes, no path)
```

Controls:

- No `app.mount("/static", ...)` for user uploads — enforced in `tests/integration`.
- Handles are opaque (`art_<uuid4>`); the filesystem layout never crosses the API.
- No embeddings, ever. OpenCV Haar cascade produces boxes only.
- Logging filter redacts handles, national IDs and file bytes
  (`app/core/logging.py`).
- Retention: `TEMP_ARTIFACT_TTL_SECONDS` (default 900), sweeper interval 60s.
- Lifecycle documented in `docs/data-privacy.md`.

---

## 9. Frontend architecture

```text
src/
├── app/          App shell, router, providers, global error boundary
├── pages/        LandingPage, IdCardPage (route targets, thin)
├── features/     One folder per product capability
│   ├── document-upload/    (Phase 2)
│   ├── verification/       methods + requirement state (Phase 5)
│   ├── identity-form/      (Phase 4)
│   ├── face-capture/       (Phase 6)
│   ├── liveness/           (Phase 7)
│   └── report/             (Phase 9)
├── components/   ui/ (design-system primitives) + verification/ (domain widgets)
├── config/       api client, runtime config
└── lib/          framework-agnostic helpers (validation, formatting)
```

Rules:

- `pages/` are thin: they compose feature components and own no business logic.
- Server state lives in a single query cache (TanStack Query); ephemeral UI state
  stays local. No new global store unless a requirement demands it (§33).
- The **requirement matrix is fetched, not hard-coded** (§4).
- All network access goes through `src/config/apiClient.ts` — one place for base
  URL, error-envelope unwrapping and request IDs.
- Nothing in `src/` ever reads a CamDX credential, endpoint or raw payload.

---

## 10. State model (§33)

Authoritative transition table in `app/domain/state_machine.py`, mirrored in
`src/features/verification/stateMachine.ts`, with a contract test comparing them.

```text
idle → uploading → processing → review_required → ready_for_verification
                                        ▲                    │
                                        │                    ├─► collecting_face ──┐
                                        │                    ├─► collecting_liveness ┤
                                        │                    └─────────────────────┘
                                                                      ▼
                                                                 verifying
                                                                      │
                                        ┌─────────────────────────────┼──────┐
                                        ▼                            ▼      ▼
                                     success                       partial  failed
```

`ready_for_verification` is *derived*, never assigned: it holds exactly when the
selected method's requirements (§4) are all satisfied. `verifying` is unreachable
otherwise — the guard is the requirement engine, not a UI `disabled` attribute.

---

## 11. Testing topology (§34)

```text
tests/                      cross-cutting
├── contract/               schema + requirement-matrix drift guards
├── e2e/                    Scenarios A–I (Playwright)
└── fixtures/               synthetic images, sanitized

backend/tests/unit/         pure domain: requirements, state machine,
                            normalizer, error mapping
backend/tests/integration/  FastAPI via ASGI transport: upload → process →
                            verify → normalized result, against MockCamDXProvider
frontend/src/**/*.test.tsx  component + hook behaviour (Vitest)
```

Testing rules:

- Domain unit tests import no I/O module. If a test needs `httpx` or OpenCV, it
  belongs in `integration/`.
- No test may hit the real CamDigiKey service. `CAMDX_MODE=mock` is forced in
  `conftest.py`.
- Biometric fixtures are generated synthetically. No real documents in Git.

---

## 12. Phase-to-module traceability

| Phase | Modules introduced |
|-------|--------------------|
| 1 | `main`, `core/*`, `api/deps`, `api/v1/health`, `domain/enums`, frontend shell, compose |
| 2 | `domain/identity` (shape only), `features/document-upload`, `pages/LandingPage` |
| 3 | `services/document_service`, `services/face_service`, `infrastructure/storage`, `infrastructure/imaging`, `integrations/camdx/mock` |
| 4 | `features/identity-form`, `components/verification/*` |
| 5 | `domain/requirements`, `domain/state_machine`, `domain/results`, `services/kyc_service`, `integrations/camdx/{provider,errors,normalizer,models,client,services/*}`, `api/v1/kyc` |
| 6 | `features/face-capture`, `services/verify_user_face|verify_user_idcard_face` |
| 7 | `features/liveness`, `api/v1/liveness`, `MockLivenessProvider` |
| 8 | `api/v1/passport`, `services/passport_ocr`, `features/passport` |
| 9 | `features/report`, result → presentation mapping |
| 10 | security, retention sweeper, full test suite, docs |

Phases 5–10 are **not** implemented until Phase 1 is validated (§38).