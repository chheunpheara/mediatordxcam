# CamDX / CamDigiKey Integration

Everything CamDigiKey-specific lives under `backend/app/integrations/camdx/`.
No other package imports `httpx` for CamDX, references a CamDX endpoint, or knows
a CamDX field name.

---

## 1. The six official APIs

| # | Official name | Internal method id | Adapter module |
|---|---------------|--------------------|----------------|
| 1 | Verify User Info | `verify_user_info` | `services/verify_user_info.py` |
| 2 | Verify User Info + User Face | `verify_user_info_face` | `services/verify_user_face.py` |
| 3 | Verify User Info + ID Card + User Face | `verify_user_info_idcard_face` | `services/verify_user_idcard_face.py` |
| 4 | Verify User Info + ID Card Image + Liveness | `verify_user_info_idcard_liveness` | `services/verify_user_liveness.py` |
| 5 | Khmer ID Card OCR | `khmer_id_card_ocr` | `services/idcard_ocr.py` |
| 6 | Passport OCR | `passport_ocr` | `services/passport_ocr.py` |

Method ids are the snake_case of the official names — deliberately, so internal
code never drifts from the documented API (§3, D3).

**No seventh API is invented.** OCR is performed through APIs 5 and 6 only; there
is no local OCR engine (§15).

---

## 2. Port and adapters (§21)

```text
             KycService / DocumentService
                        │
                        ▼
                 CamDXProvider (port)
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
 MockCamDXProvider              RealCamDXProvider
        │                               │
 fixtures only                  CamDXClient (httpx)
                                        │
                                        ▼
                                six service modules
```

```python
class CamDXProvider(Protocol):
    # Verification
    async def verify_user_info(self, req: VerifyRequest) -> VerifyOutcome: ...
    async def verify_user_info_face(self, req: VerifyFaceRequest) -> VerifyOutcome: ...
    async def verify_user_info_idcard_face(self, req: VerifyIdCardFaceRequest) -> VerifyOutcome: ...
    async def verify_user_info_idcard_liveness(self, req: VerifyLivenessRequest) -> VerifyOutcome: ...
    # OCR
    async def ocr_khmer_id_card(self, image: ArtifactRef) -> KhmerIdCardOcrResult: ...
    async def ocr_passport(self, image: ArtifactRef) -> PassportOcrResult: ...
    # Liveness
    async def start_liveness(self, req: LivenessStartRequest) -> LivenessSessionHandle: ...
    async def complete_liveness(self, ref: LivenessSessionRef) -> LivenessOutcome: ...
```

Selection is factory-only, driven by one setting (§22):

```python
def build_camdx_provider(settings: Settings) -> CamDXProvider:
    if settings.camdx_mode is CamDXMode.MOCK:
        return MockCamDXProvider(settings=settings)
    if not settings.camdx_credentials_present:
        raise ConfigurationError(
            "CAMDX_MODE=real requires CAMDX_CLIENT_ID, CAMDX_CLIENT_SECRET and CAMDX_BASE_URL."
        )
    return RealCamDXProvider(client=CamDXClient(settings=settings))
```

The factory refuses to start rather than silently degrading to mock. A production
deployment cannot accidentally run on fixtures.

Both adapters implement the same protocol, so switching modes changes no
frontend code and no service code (§21).

---

## 3. Mock implementation

`integrations/camdx/mock/` is importable only when `CAMDX_MODE=mock`. It uses no
network, no credentials and no environment lookups.

| Component | Purpose |
|-----------|---------|
| `MockCamDXProvider` | Deterministic responses for all six APIs |
| `MockLivenessProvider` | Liveness session simulation, isolated for Phase 7 (§18) |
| `fixtures/` | Synthetic Khmer ID / passport payloads |
| `scenarios.py` | Trigger codes that select success / partial / failure outcomes |

Mock behaviour is deterministic by default: the same input always yields the same
outcome, so tests never flake. Outcomes are steered only by documented triggers —
never by random failure.

| Trigger | Effect |
|---------|--------|
| national ID `000000000` | `IDENTITY_NOT_VERIFIED` (Scenario F) |
| national ID `111111111` | partial match — DOB mismatched |
| current face artifact tagged `face_mismatch` | `FACE_NOT_VERIFIED` (Scenario G) |
| liveness action set includes `nod` | session fails → `LIVENESS_FAILED` (Scenario I) |

`MockLivenessProvider` is a separate class precisely so it can be replaced by
the real CamDX liveness implementation without touching `MockCamDXProvider`
or the UI (§18).

---

## 4. Real implementation

`RealCamDXProvider` composes six thin service modules. Each owns exactly one
API's request and response shape, and each returns the shared outcome types
(`VerifyOutcome`, `KhmerIdCardOcrResult`, `PassportOcrResult`,
`LivenessOutcome`) so callers are mode-agnostic.

```text
RealCamDXProvider
   ├── VerifyUserInfoService            (API 1)
   ├── VerifyUserFaceService            (API 2)
   ├── VerifyUserIdCardFaceService      (API 3)
   ├── VerifyUserLivenessService        (API 4)
   ├── IdCardOcrService                 (API 5)
   └── PassportOcrService               (API 6)
        └── all use CamDXClient
```

### `client.py` responsibilities

- OAuth/client-credential acquisition and refresh
- `CAMDX_TIMEOUT` (default 30s) and connect/read timeouts
- Bounded retry with exponential backoff on `429`/`5xx` and transport errors only
- Idempotency key per verification attempt, so a retried submit cannot create a
  duplicate verification
- Correlation id forwarded into our logs
- Redaction of credentials and payload bytes — the client never logs bodies (§29)

The client raises typed `CamDX*Error` subclasses. It never returns a transport
error to the caller as if it were a business result.

---

## 5. Error translation (§28)

```text
CamDX technical error
      │  integrations/camdx/exceptions.py   typed upstream error
      ▼
CamDX upstream code / reason
      │  integrations/camdx/errors.py       → business code + safe message
      ▼
AppError
      │  core/errors.py                    → HTTP status
      ▼
{ error: { code, message, fieldErrors, requestId } }
      ▼
React toast / inline error
```

| Upstream condition | Business code | User sees |
|--------------------|---------------|-----------|
| Identity fields differ | `IDENTITY_NOT_VERIFIED` | The submitted identity information could not be verified. |
| Face match negative | `FACE_NOT_VERIFIED` | The current face could not be verified. |
| Document unreadable | `OCR_UNREADABLE` | The ID Card could not be read. |
| Liveness negative / action failed | `LIVENESS_FAILED` | The liveness verification was unsuccessful. |
| Credential rejected | `UPSTREAM_AUTH_FAILED` | We could not reach the verification service. Please try again later. |
| Timeout | `UPSTREAM_TIMEOUT` | The verification service took too long to respond. Please try again. |
| `5xx` from CamDX | `UPSTREAM_UNAVAILABLE` | The verification service is temporarily unavailable. Please try again later. |
| Malformed upstream body | `UPSTREAM_BAD_RESPONSE` | We could not complete the verification. Please try again. |

Two rules are enforced by tests, not convention:

1. No upstream status code, endpoint path or vendor message appears in a response
   body.
2. No `5xx` reaches the browser with an unmapped body; every `5xx` is one of the
   mapped `UPSTREAM_*` codes.

Transport/auth failure is a **technical** condition and never becomes a
verification outcome. It surfaces as an error, not as `status: "failed"` —
otherwise a user would be told their identity was rejected when the service was
merely unavailable.

---

## 6. Normalization (§23)

`normalizer.py` is the **only** module that knows a CamDX response shape.

```text
raw CamDX body
   ▼ normalizer.py
VerifyOutcome / KhmerIdCardOcrResult / PassportOcrResult   (domain types)
   ▼ services/kyc_service.py
KycResult                                                   (§23)
   ▼ api/schemas/results.py
KycResultResponse
```

Field comparison happens here, once:

- Fields are compared as normalized values (trimmed, case-folded names, dates
  parsed to ISO), never as raw strings
- Identity matching is per-field, producing `matched` plus the list of
  mismatching fields — the source of §26's partial report
- Scores are read here and attached to `developerView` only, never to the
  user-facing DTO (D10)
- Any field CamDX omits is reported as *not checked*, never as *mismatch*. An
  unchecked field must not render as a failure.

---

## 7. Open questions for real integration

Unknowns are recorded rather than guessed (§38). Each is isolated to one module.

| # | Question | Blocks | Isolated in |
|---|----------|--------|-------------|
| Q1 | Exact endpoint paths and auth scheme per API | Phase 5 real mode | `client.py` |
| Q2 | Whether API 4 liveness is hosted, embedded, or a session/redirect flow | Phase 7 | `services/verify_user_liveness.py` |
| Q3 | Required liveness action set and ordering | Phase 7 | `MockLivenessProvider` + API 4 service |
| Q4 | Khmer ID OCR field names and value formats (date order, Khmer numerals, gender encoding) | Phase 3 mapper | `services/idcard_ocr.py` |
| Q5 | Passport OCR field set | Phase 8 | `services/passport_ocr.py` |
| Q6 | Rate limits and per-endpoint quotas | Phase 10 | `client.py` |
| Q7 | Whether API 3 compares the submitted ID card against the record or only checks readability | Phase 5 | `normalizer.py` |
| Q8 | Sandbox/test environment availability for contract tests | Phase 10 | `tests/` |

No placeholder endpoint is fabricated for these. In the meantime the mock path
is complete and the real seam is a single adapter swap.

---

## 8. Switching to real mode

```bash
CAMDX_MODE=real
CAMDX_BASE_URL=<provided by CamDX>
CAMDX_CLIENT_ID=<provided by CamDX>
CAMDX_CLIENT_SECRET=<provided by CamDX>
CAMDX_API_KEY=<if required>
CAMDX_TIMEOUT=30
```

1. Implement the six service modules against real endpoints (Q1, Q4, Q5).
2. Implement the liveness flow (Q2, Q3).
3. Point the normalizer at real response shapes.
4. Keep the mock adapter; it stays the default for tests and CI.
5. Frontend is untouched — the wire contract is defined by our own
   `KycResultResponse`, not by CamDX (§23).