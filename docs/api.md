# Application API

All application endpoints live under `/api/v1`. These are **our** APIs — not
CamDX's. CamDigiKey is reached only server-side, through `CamDXProvider`.

Base URL in development: `http://localhost:8000`.

---

## Conventions

### Content types

- Requests: `application/json`, except image endpoints → `multipart/form-data`
- Responses: `application/json` always. No endpoint returns raw CamDX payloads.

### Request IDs

Every response carries `X-Request-Id`. Clients may send their own; the server
echoes it back so a user-visible error can be traced without exposing internals.

### Error envelope

```json
{
  "error": {
    "code": "FACE_NOT_DETECTED",
    "message": "We couldn't detect a face on this ID Card.",
    "fieldErrors": { "face": "Please upload a clearer ID Card." },
    "requestId": "req_8f2c1a9e4b7d4c0f"
  }
}
```

| Field | Purpose |
|-------|---------|
| `code` | Stable business code for programmatic branching |
| `message` | Safe, user-facing sentence — never a raw upstream string (§28) |
| `fieldErrors` | Optional per-field messages for inline form display |
| `requestId` | Correlation id for support; the only diagnostic the UI exposes |

### Status codes

| Code | Used for |
|------|----------|
| `200` | Success |
| `400` | Malformed request (bad multipart, undecodable image) |
| `404` | Unknown or expired artifact handle |
| `409` | Illegal state transition (§33) |
| `413` | Upload exceeds size limit |
| `415` | Unsupported media type |
| `422` | Business validation failed — missing requirements, unreadable OCR |
| `429` | Rate limited (Phase 10) |
| `502` / `504` | Upstream CamDX failure, already translated to a safe message |
| `500` | Unexpected fault — message is generic, detail goes to logs only |

---

## Phase 1 — Health

### `GET /health`

Unversioned liveness probe for Docker and load balancers. No dependency checks.

```json
{ "status": "ok" }
```

### `GET /api/v1/health`

Readiness probe with build and configuration facts. Intended for developers and
operators — never rendered in the verification UI.

```json
{
  "status": "ok",
  "service": "camdx-kyc-backend",
  "version": "0.1.0",
  "environment": "local",
  "camdxMode": "mock",
  "time": "2026-10-03T10:15:00Z"
}
```

`status` is `"degraded"` with HTTP `503` when a required dependency is
unavailable. With `CAMDX_MODE=mock` no upstream is contacted, so mock mode is
always `ok`.

---

## Phase 2–10 — Identity verification

### `GET /api/v1/kyc/verification-methods` · Phase 5

The requirement matrix (§11). This endpoint is the frontend's source of truth for
what each method needs — the UI must not hard-code it.

```json
{
  "methods": [
    {
      "id": "verify_user_info",
      "name": "Identity Information",
      "officialApiName": "Verify User Info",
      "description": "Check the identity details you entered.",
      "requirements": {
        "userInfo": true,
        "currentFace": false,
        "idCard": false,
        "liveness": false,
        "passport": false
      }
    },
    {
      "id": "verify_user_info_idcard_liveness",
      "name": "Identity + ID Card + Liveness",
      "officialApiName": "Verify User Info + ID Card Image + Liveness",
      "description": "Strongest check: identity, ID Card and a live face check.",
      "requirements": {
        "userInfo": true,
        "currentFace": false,
        "idCard": true,
        "liveness": true,
        "passport": false
      }
    }
  ]
}
```

All six methods are returned; the example above is abbreviated. `userInfo` is
implied by the presence of `requiresUserInfo` in §11's shape — the wire names
above are the shortened camelCase form.

---

### `POST /api/v1/kyc/id-card/process` · Phase 3

Extracts identity data via CamDX API 5 and detects the face region locally.

**Request** — `multipart/form-data`

| Field | Type | Notes |
|-------|------|-------|
| `file` | binary | JPG / JPEG / PNG / WebP |
| `documentType` | enum | `khmer_id_card` (default), `passport` |

**Response `200`**

```json
{
  "processingId": "proc_4b1d9f0c2a",
  "status": "completed",
  "document": {
    "filename": "id-card.jpg",
    "artifactHandle": "art_9c1e77a0",
    "width": 1024,
    "height": 640,
    "expiresInSeconds": 900
  },
  "ocr": {
    "status": "completed",
    "provider": "camdx-mock",
    "fields": {
      "nationalId": "012345678",
      "firstNameKhmer": "សុភា",
      "lastNameKhmer": "សាជា",
      "firstNameEnglish": "SOPHEA",
      "lastNameEnglish": "SACH",
      "gender": "female",
      "dateOfBirth": "1995-04-12",
      "issuedDate": "2019-08-01",
      "expiredDate": "2029-08-01"
    },
    "unreadableFields": []
  },
  "face": {
    "status": "detected",
    "source": "local_opencv_detection",
    "isVerificationResult": false,
    "artifactHandle": "art_51ab90cd",
    "boundingBox": { "x": 612, "y": 188, "width": 214, "height": 268 },
    "confidence": 0.87
  },
  "warnings": [],
  "requestId": "req_8f2c1a9e4b7d4c0f"
}
```

`ocr.fields` contains only fields CamDX actually returned. Missing fields are
absent and listed in `unreadableFields`; the UI shows "Please enter this
information." The backend never invents a value (§16).

`face.source` is `local_opencv_detection` and `face.isVerificationResult` is
`false` by construction (§13). There is no way for this endpoint to report a
face verification outcome.

**Failure responses**

| Code | HTTP | Message |
|------|------|---------|
| `FACE_NOT_DETECTED` | `422` | We couldn't detect a face on this ID Card. |
| `MULTIPLE_FACES_DETECTED` | `422` | Multiple faces were detected. Please upload a valid ID Card image. |
| `FACE_QUALITY_TOO_LOW` | `422` | The face image is unclear. Please upload a clearer ID Card. |
| `IMAGE_UNREADABLE` | `400` | We could not read that image. Please try another file. |
| `IMAGE_TOO_LOW_RESOLUTION` | `422` | The image quality is too low. Please upload a clearer ID Card. |
| `IMAGE_TOO_LARGE` | `413` | The image is too large. |
| `UNSUPPORTED_IMAGE_TYPE` | `415` | Please upload a JPG, PNG or WebP image. |
| `OCR_UNREADABLE` | `422` | We could not read this ID Card. Please upload a clearer image. |

---

### `POST /api/v1/kyc/verify` · Phase 5+

Runs the selected method. Validates requirements independently of the frontend
(§11), then dispatches to the matching CamDX adapter.

**Request** `application/json`

```json
{
  "method": "verify_user_info_idcard_face",
  "userInfo": {
    "nationalId": "012345678",
    "firstNameKhmer": "សុភា",
    "lastNameKhmer": "សាជា",
    "firstNameEnglish": "SOPHEA",
    "lastNameEnglish": "SACH",
    "gender": "female",
    "dateOfBirth": "1995-04-12",
    "issuedDate": "2019-08-01",
    "expiredDate": "2029-08-01"
  },
  "idCardArtifactHandle": "art_9c1e77a0",
  "currentFaceArtifactHandle": "art_77bc31de",
  "livenessSessionId": null
}
```

Only the fields the selected method requires may be sent. Sending an artifact
the method does not require is ignored, not an error.

**Response `200`** — normalized result (§23). Same shape for success, partial and
failure; only `status` and the section outcomes differ.

```json
{
  "verificationId": "ver_7d2e91c4",
  "method": "verify_user_info_idcard_face",
  "methodLabel": "Identity + ID Card + Face",
  "status": "partial",
  "identity": {
    "required": true,
    "matched": false,
    "checkedFields": [
      { "field": "nationalId", "label": "National ID", "status": "matched" },
      { "field": "firstNameEnglish", "label": "First Name", "status": "matched" },
      { "field": "lastNameEnglish", "label": "Last Name", "status": "matched" },
      { "field": "dateOfBirth", "label": "Date of Birth", "status": "mismatch" },
      { "field": "gender", "label": "Gender", "status": "matched" }
    ],
    "incorrectFields": ["dateOfBirth"]
  },
  "face": {
    "required": true,
    "verified": true,
    "source": "camdx",
    "statusLabel": "Face verified"
  },
  "idCard": { "required": true, "verified": true, "statusLabel": "ID Card verified" },
  "liveness": { "required": false, "verified": null, "statusLabel": "Not required" },
  "ocr": null,
  "message": "Some identity details could not be confirmed. Please check the highlighted fields and try again.",
  "actions": [
    { "id": "retry", "label": "Try Again", "kind": "primary" },
    { "id": "edit_identity", "label": "Edit Details", "kind": "secondary" }
  ],
  "requestId": "req_2f8a44d1c9"
}
```

`status` ∈ `success | partial | failed`. There is no separate HTTP failure for a
business-negative verification — a mismatch is a successful API call whose result
is `failed`/`partial`. HTTP errors are reserved for malformed or unprocessable
requests (§28).

Absent sections are `required: false`, letting the report render only what
applies (§25).

**Validation failure `422`**

```json
{
  "error": {
    "code": "REQUIREMENTS_NOT_MET",
    "message": "Some required information is missing.",
    "fieldErrors": {
      "currentFaceArtifactHandle": "Please take a photo of your face."
    },
    "missing": ["currentFace"],
    "requestId": "req_2f8a44d1c9"
  }
}
```

`missing` names the unsatisfied requirements by their §11 flag, so the frontend
can react programmatically rather than parsing prose.

---

### Liveness · Phase 7

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/kyc/liveness/sessions` | Start a session, receive required actions |
| `GET` | `/api/v1/kyc/liveness/sessions/{id}` | Poll session state |
| `POST` | `/api/v1/kyc/liveness/sessions/{id}/actions` | Submit one completed action |
| `POST` | `/api/v1/kyc/liveness/sessions/{id}/complete` | Finalize; yields `livenessSessionRef` for `verify` |

Liveness is a session, not an upload: `/verify` accepts a liveness **session
reference**, never raw liveness images (§18, D11).

---

### `POST /api/v1/kyc/passport/process` · Phase 8

Independent of the ID-card flow (§2 API 6). Mirrors the response shape of
`id-card/process` with `documentType: "passport"`, no face extraction (passport
photo data is not extracted locally), and `document.fields` carrying passport
fields instead of Khmer ID fields.

---

## Artifact streaming · Phase 3

`GET /api/v1/artifacts/{handle}` streams stored bytes with
`Cache-Control: no-store`. There is no static directory mount — that is the
mechanism that keeps biometrics out of public reach (§29, D8).

The handle is opaque and short-lived; a guessable path yields `404`, and an
expired handle yields `404 ARTIFACT_EXPIRED`.