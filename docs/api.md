# Application API

All application endpoints live under `/api/v1`. These are **our** APIs — not
CamDX's. CamDigiKey is reached only server-side, through `CamDXProvider`.

Base URL in development: `http://localhost:8000`. The browser never addresses it
directly in the Docker stack — nginx on `:3000` forwards these same paths — but
every path below is valid on either origin.

---

## Conventions

### Content types

- Requests: `application/json`, except image endpoints → `multipart/form-data`
- Responses: `application/json`, except the artefact route → the stored image's own
  type. No endpoint returns raw CamDX payloads.
- Uploads accept JPEG, PNG and WebP (§6). The declared content type is not
  trusted; the bytes are identified from their magic number, so a renamed GIF is
  rejected and a PNG sent as `image/jpeg` is accepted and reported as a PNG.
  WebP is a RIFF container, so its `WEBP` form type is checked 8 bytes in — a
  `RIFF` file that is not WebP (WAV, AVI) stays unrecognised.

### Caching

Every `/api/` response is sent with `Cache-Control: no-store, private` and
`Pragma: no-cache`, applied by middleware rather than per endpoint. Any API
response can carry identity data or an artefact handle that stops resolving once
its artefact expires, so a cached copy would outlive both the data and the consent
to keep it (§29).

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
| `201` | Resource created (account, role) |
| `204` | Success with no body (logout, delete) |
| `400` | Malformed request (bad multipart, undecodable image) or form refusal with `fieldErrors` |
| `401` | No valid session (`UNAUTHENTICATED`); carries `WWW-Authenticate: Bearer` |
| `403` | Signed in, but not permitted (`FORBIDDEN`) |
| `404` | Unknown or expired artifact handle |
| `409` | Illegal state transition (§33): role still held, last administrator |
| `413` | Upload exceeds size limit |
| `415` | Unsupported media type |
| `422` | Business validation failed — missing requirements, unreadable OCR |
| `429` | Rate limited (Phase 10) |
| `502` / `504` | Upstream CamDX failure, already translated to a safe message |
| `500` | Unexpected fault — message is generic, detail goes to logs only |

`401` and `403` are reserved for authentication and authorisation (§28). A
request that is signed in and permitted but has the wrong *inputs* is still
`422` or `400` — no business failure borrows an auth status, and no auth
failure borrows a business code.

---

## Sign-in and administration · D18

With `AUTH_ENABLED=true` (the default) every route requires a session, except:

- `GET /health` and `GET /api/v1/health` — probes;
- `/docs` and `/openapi.json` — the schema itself;
- `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`.

`AUTH_ENABLED=false` opens the whole API for local exploration; it is what the
backend test suite forces so that pre-authentication tests keep their meaning.
It never weakens verification — only the gate around it.

### Sessions

Sign-in issues an opaque random token stored server-side with a 12-hour
lifetime. A browser receives it twice, deliberately:

| Where | Why |
|-------|-----|
| `camdx_session` cookie — `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` only in production | The SPA never reads it, so no script can steal it; `fetch` attaches it automatically (CORS runs with `allow_credentials`) |
| `token` in the login response body | For curl, tests and any client that cannot keep a cookie jar |

Nothing about the token is signed or self-contained. Logout deletes the row,
disabling an account invalidates its sessions on the next request, and every
call re-derives the user's permissions from the database — there is no claim a
client could present to talk its way past a revoked session.

### `POST /api/v1/auth/login` · public

```json
{ "email": "admin@gmail.com", "password": "P4ssw0rd!" }
```

**Response `200`** — sets the cookie and returns:

```json
{
  "token": "hMq9…",
  "user": {
    "id": "usr_…",
    "email": "admin@gmail.com",
    "name": "Administrator",
    "status": "active",
    "roles": [{ "id": "rol_…", "name": "Admin" }],
    "isAdmin": true,
    "permissions": [
      "verify_user_info",
      "verify_user_info_face",
      "verify_user_info_idcard_face",
      "verify_user_info_idcard_liveness",
      "khmer_id_card_ocr",
      "passport_ocr"
    ]
  }
}
```

Failure modes are deliberately coarse so the form cannot enumerate accounts
(§30):

| Case | HTTP | `code` | Message |
|------|------|--------|---------|
| Unknown email or wrong password — identical for both | `401` | `UNAUTHENTICATED` | That email or password is incorrect. |
| Account disabled | `403` | `FORBIDDEN` | This account has been disabled. Please contact an administrator. |

### `POST /api/v1/auth/logout` · session optional

Deletes the session if one was presented and answers `204` either way —
signing out twice, or after the session already expired, is not an error.

### `GET /api/v1/auth/me` · authenticated

The signed-in account, in the same shape as `user` above; `401` when there is
no valid session. The SPA does not call it on load (the stored profile covers
the first paint); it exists for clients and for debugging.

### Permission enforcement

| Endpoint | Behaviour |
|----------|-----------|
| Any admin route without an administrative role | `403 FORBIDDEN` before the handler runs |
| `GET /api/v1/kyc/verification-methods` | Allowed for every signed-in user; methods outside the user's permissions come back `available: false` with `unavailableReason: "Your account does not have access to this verification method."` — all six stay visible (§9), only the run is withheld |
| `POST /api/v1/kyc/verify` | Checked first: without the method's permission the answer is `403 FORBIDDEN` with that same sentence, before any input is examined |

A permission is a verification-method id (`verify_user_info`, …), so the admin
matrix, the method cards and the enforcement point share one vocabulary.

### Password policy

One sentence, wherever it is tripped:

> Password must be at least 8 characters and include an upper-case letter, a lower-case letter, a number and a symbol.

Length above 128 answers with its own message. Violations arrive as
`fieldErrors.password` alongside a `400 INVALID_REQUEST`, so the admin form
shows them inline.

### Account administration · admin-only

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/admin/permissions` | The six assignable permissions with their labels |
| `GET` | `/api/v1/admin/users` | Every account with roles and status |
| `POST` | `/api/v1/admin/users` | Create an account (`201`) |
| `PATCH` | `/api/v1/admin/users/{id}` | Change name, roles, status or password; omitted fields stay unchanged |
| `DELETE` | `/api/v1/admin/users/{id}` | Delete an account (`204`) |
| `GET` | `/api/v1/admin/roles` | Every role with its permission keys |
| `POST` | `/api/v1/admin/roles` | Create a role (`201`) |
| `PATCH` | `/api/v1/admin/roles/{id}` | Rename or grant/remove administrator rights |
| `PUT` | `/api/v1/admin/roles/{id}/permissions` | Replace the role's permission set wholesale |
| `DELETE` | `/api/v1/admin/roles/{id}` | Delete a role nobody holds (`204`) |

The guards live in `AuthService` and are tested there: you can never delete
yourself, never remove the last active administrator's rights or account
(`403`, `409`), never delete a role a user still holds (`409`), and duplicate
emails or role names answer `400` with the failing field named.

### Seeds

A fresh database seeds idempotently by natural key (role name, admin email):

| Role | Admin rights | Permissions |
|------|--------------|-------------|
| `Admin` | yes | all six |
| `Senior Loan Officer` | no | all six |
| `Loan Officer` | no | `verify_user_info`, `verify_user_info_face` |

plus the account `admin@gmail.com` / `P4ssw0rd!` holding `Admin` — a
documented local placeholder (requirement 5); a deployment's first act is
changing it. The auth tables live in the same database as everything else
(`DATABASE_URL`), falling back to `var/auth.db` when no database is configured.

---

## Third-party integration · D19, D22

Two controls, one gate. **Post Settings** (the gear in the workspace header)
— including the per-row **Test Connection** probe (D22) — and **Post to Core
Systems** (beneath the Verification Response card) render
only for accounts holding all six verification permissions — exactly `Admin`
and `Senior Loan Officer` in the seeds — and every route below answers `403
FORBIDDEN` with *"You need every verification permission to post to core
systems."* for anyone else, before the handler runs. The browser's display
gate mirrors that rule; it never replaces it.

### `GET /api/v1/integrations/settings` · full-permission

Every configured system. A password is never part of any response:

```json
{ "settings": [{ "id": "its_…", "url": "https://core.example/post", "apiUser": "svc_camdx" }] }
```

### `PUT /api/v1/integrations/settings` · full-permission

Replaces the complete list:

```json
{
  "settings": [
    { "id": null, "url": "https://core-a.example/post", "apiUser": "svc_camdx", "apiPassword": "…" },
    { "id": "its_…", "url": "https://core.example/post/v2", "apiUser": "svc_camdx", "apiPassword": "" }
  ]
}
```

An `id` names an existing row; a blank password for such a row keeps the
stored one — the dialog cannot read a secret back just to send it again. A
new row without a password is refused. Validation answers `400
INVALID_REQUEST` with `fieldErrors` keyed
`settings.<index>.<url|apiUser|apiPassword>`, and a refused save leaves the
stored list untouched (all-or-nothing).

### `POST /api/v1/integrations/test` · full-permission

Probes one system **before** it is saved — the row exactly as the dialog
holds it:

```json
{ "id": "its_…", "url": "https://core.example/post", "apiUser": "svc_camdx", "apiPassword": "" }
```

A blank password for an existing row uses the stored credential (the same
rule `PUT` applies); a new or unknown row without one is refused. The probe
is one POST with HTTP Basic auth and the same 10-second timeout as a real
post, but carrying only `{ "connectionTest": true }` — a test never carries
subject data (§29). The answer is always `200`:

```json
{ "ok": true, "reason": null }
```

with `reason` one of the four fixed sentences below when `ok` is `false`.
Malformed input answers `400 INVALID_REQUEST` with `fieldErrors` keyed by
the bare field name (`url`, `apiUser`, `apiPassword`).

### `POST /api/v1/integrations/post` · full-permission

The verification response as `{ "payload": … }`, replayed to every configured
system with HTTP Basic auth and a 10-second timeout per target. When
something is configured the answer is always `200`, one entry per system:

```json
{
  "posted": ["https://core-a.example/post"],
  "failed": [{ "url": "https://core-b.example/post", "reason": "The system timed out." }]
}
```

Reasons are fixed safe sentences — timed out, could not be reached, refused
the API credentials, did not accept the submission — so no upstream body,
host detail or driver text reaches the client (§28). With nothing configured
the answer is `400 INVALID_REQUEST`: *"There are no core systems configured
yet. Add one in Post Settings first."* — an empty success must never
masquerade as delivery.

The settings share the auth database (`DATABASE_URL`, else `var/auth.db`),
which therefore holds the outbound credentials in recoverable form: they must
be replayed on every post, but they are never returned by the API and never
logged.

---

## Uploaded records · D23

Bulk verification data, in five endpoints. Unlike `/integrations`, every
route here needs only a signed-in account (`· authenticated`): the Loan
Officer who verifies one identity at a time is the same person uploading the
batch. The CSV or Excel file itself never reaches the server — the browser
parses it, the mapping step pairs its columns with the nine §14 fields, and
only the resulting values are submitted (§29). Records and the saved mapping
share the auth database with everything else.

### `GET /api/v1/records` · authenticated

One page of the list, newest first, with everything the list's controls send
in a single call:

| Query | Meaning |
|-------|---------|
| `search` | Case-insensitive substring across the record's *values* (0-200 chars; field names are never searched) |
| `status` | `pending` or `verified`; omitted keeps both |
| `limit` | Page size, 1-50 (default 10) |
| `offset` | Rows to skip (default 0) |

```json
{
  "records": [
    {
      "id": "3f2a…",
      "status": "pending",
      "values": {
        "nationalId": "123456789",
        "firstNameKhmer": "ចាន់",
        "lastNameKhmer": "សុខ",
        "firstNameEnglish": "Chann",
        "lastNameEnglish": "Sok",
        "gender": "Female",
        "dateOfBirth": "2000-01-01",
        "issuedDate": "2020-01-01",
        "expiryDate": "2030-01-01"
      },
      "verification": null,
      "createdAt": 1769900000.0,
      "verifiedAt": null
    }
  ],
  "total": 1
}
```

`total` is how many records the filter matched in total, not this page's
length. An unknown `status`, a `limit` outside 1-50 or a `search` over 200
characters is `400 INVALID_REQUEST`.

### `POST /api/v1/records` · authenticated

Add the reviewed rows from the dialog's last step:

```json
{ "records": [ { "nationalId": "123456789", "firstNameEnglish": "Chann" } ] }
```

Each entry is the nine §14 field names, any subset of them (absent fields are
stored as blanks); 1-500 entries per submission, answered `201` with what was
created. A record whose every value is blank is refused — it could never be
verified — as `400` with `fieldErrors` keyed `records.<index>.values`, and a
stray key lands at `records.<index>.<key>` (schema `extra=forbid`).

### `POST /api/v1/records/{record_id}/verification` · authenticated

Store the outcome of a run whose record was on screen, flipping its Status to
`verified`:

```json
{
  "verification": {
    "status": "success",
    "method": "verify_user_info",
    "identity": { "fields": [], "matchedCount": 9, "incorrectFields": [] },
    "face": { "required": false },
    "idCard": { "required": false },
    "liveness": { "required": false }
  }
}
```

`verification` is exactly what `POST /api/v1/kyc/verify` returned — the same
`VerifyResponse`, no more — and the response is the record with
`status: "verified"`, the stored outcome and a server-stamped `verifiedAt`
that Preview later renders. An unknown id is `404 NOT_FOUND`; a stray key in
the outcome is `400` keyed `verification.<key>`.

### `GET /api/v1/records/mappings` · authenticated

The one reusable column mapping, or `null` if nothing was saved yet:

```json
{ "mapping": { "ID Number": "nationalId", "DOB": "dateOfBirth" } }
```

### `PUT /api/v1/records/mappings` · authenticated

Replace it — keys are file column names, values must be §14 field names.
The dialog pre-applies this mapping to the next file whose columns line up,
which is why there is exactly one (like the posting settings): one house
template, re-editable by hand whenever a file differs. A column mapping to an
unknown field is `400` keyed `mapping.<column>`; the same field claimed twice
is `400` keyed by the column that repeated it; a blank column name is `400`
keyed `mapping`.

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

### `GET /api/v1/kyc/verification-methods` · Phase 5 (implemented)

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

Extracts identity data via the CamDigiKey OCR provider and detects the portrait
locally with OpenCV.

**Request** — `multipart/form-data`

| Field | Type | Notes |
|-------|------|-------|
| `document` | binary | JPEG, PNG or WebP. |

The field is named `document` because the endpoint is document-specific; a
passport endpoint takes `document` too.

Only JPEG, PNG and WebP are accepted, matching the browser's own picker (§6).
The declared content type is not trusted: the bytes are identified from their
magic number, so a GIF or BMP renamed to `image/jpeg` is rejected as
`UNSUPPORTED_IMAGE_TYPE`, and a PNG sent as `image/jpeg` is accepted and reported
as a PNG.

WebP dimensions are read from the container header, not by decoding. The chunk
type selects the layout, because WebP encodes its size three ways:

| Chunk | Encoding | Size lives at |
|-------|----------|---------------|
| `VP8 ` | lossy bitstream | bytes 26–29, 14 bits each, after the `9D 01 2A` sync code |
| `VP8L` | lossless | 32-bit word at byte 21: 14 bits width, 14 bits height |
| `VP8X` | extended | 24-bit little-endian canvas size at bytes 24–29 |

**Response `200`**

```json
{
  "processingId": "proc_4b1d9f0c2a8e5d3b7a1c9e2f4d6b8a0",
  "status": "partial",
  "ocr": {
    "status": "partial",
    "documentType": "khmer_id_card",
    "fields": {
      "nationalId": "000000000000",
      "firstNameKhmer": "សុខា",
      "lastNameKhmer": "ចម",
      "firstNameEnglish": "SAMPLE",
      "lastNameEnglish": "PERSON",
      "dateOfBirth": null,
      "gender": "M",
      "issuedDate": "2020-01-01",
      "expiryDate": "2030-01-01"
    },
    "missingFields": ["dateOfBirth"]
  },
  "face": {
    "status": "not_detected",
    "source": "local_opencv_detection",
    "detectedCount": 0,
    "box": null,
    "faceRef": null,
    "quality": null
  },
  "documentRef": "art_9c1e77a0d3f24b8e9a5c7e1f3b5d7092"
}
```

`ocr.fields` contains only what OCR actually read. Every field is nullable and
`null` means "not extracted"; `ocr.missingFields` lists those names so the UI can
prompt for them ("Please enter this information."). The backend never invents a
value (§16). `status` is `partial` whenever `missingFields` is non-empty — the
two can never disagree.

The nine field names are fixed by §14 and asserted by equality in the integration
suite, so the form's rows and this payload cannot drift apart:

| Field | §14 row |
| --- | --- |
| `nationalId` | National ID |
| `firstNameKhmer` | First Name — Khmer |
| `lastNameKhmer` | Last Name — Khmer |
| `firstNameEnglish` | First Name — English |
| `lastNameEnglish` | Last Name — English |
| `gender` | Gender |
| `dateOfBirth` | Date of Birth |
| `issuedDate` | Issued Date |
| `expiryDate` | Expired Date |

Khmer and English names are four separate values rather than a transliterated
pair, because a Cambodian ID card prints the holder's name in both scripts and the
two differ. All nine are editable in the browser (§14); corrections are held
client-side and are submitted as "user information" to
`POST /api/v1/kyc/verify`. Nothing is written server-side from the form.

OCR and face detection are independent. A card whose portrait cannot be found
still returns its identity fields, and vice versa.

**The `face` object carries no verification claim (§13)**

| Field | Meaning |
|-------|---------|
| `status` | `detected`, `not_detected`, `multiple`, or `low_quality`. |
| `source` | Always `local_opencv_detection`. Present so the client never has to infer the provenance. |
| `detectedCount` | Faces found. Distinguishes `multiple` from `not_detected`. |
| `box` | Bounding box in pixels of the original image, or `null`. |
| `faceRef` | Opaque handle to the cropped portrait. Fetch it from the artefact endpoint. |
| `quality` | Sharpness of the crop (Laplacian variance). **Not** a match score. |

There is deliberately **no** `verified`, `matchScore` or `confidence` field. A
Haar cascade cannot produce a meaningful confidence, and naming a number
`confidence` would invite the UI to present a local detection as a government
result. When more than one face is present the endpoint returns `multiple` and no
crop rather than guessing which portrait is the user.

Image bytes are never inlined in the response — only opaque handles (§29).

**Failure responses**

| Code | HTTP | Message |
|------|------|---------|
| `OCR_UNREADABLE` | `422` | We could not read this ID Card. Please upload a clearer image. |
| `IMAGE_UNREADABLE` | `400` | File is corrupted or cannot be read as an image. |
| `IMAGE_TOO_LOW_RESOLUTION` | `422` | Image is too small. Minimum resolution is 640 × 480 pixels. |
| `IMAGE_TOO_LARGE` | `413` | File is too large. Maximum size is 10 MB. |
| `UNSUPPORTED_IMAGE_TYPE` | `415` | Please upload a JPG, PNG or WebP image. |

These four messages are byte-for-byte the ones the browser shows before uploading
(`frontend/src/features/document-upload/validation.ts`). Both layers reject the
same problems, so a user is never told one thing by the file picker and another by
the server. `tests/integration/test_upload_rules_contract.py` asserts it.

`FACE_NOT_DETECTED`, `MULTIPLE_FACES_DETECTED` and `FACE_QUALITY_TOO_LOW` are **not**
errors here. They are ordinary outcomes reported inside `face.status`, so a user
with a readable card but an unclear portrait still gets their identity fields back
instead of losing the whole submission.

The resolution message is rendered from the configured `MIN_IMAGE_WIDTH` /
`MIN_IMAGE_HEIGHT` rather than hard-coded, so it cannot drift away from the limits
actually enforced.

---

### `POST /api/v1/kyc/verify` · Phase 5 (implemented) / Phase 9 (full report)

Runs the selected method. Validates requirements independently of the frontend
(§11), then dispatches to the matching CamDX adapter.

> **The contract below is the Phase 9 target, not today's response.** Phase 5
> ships the endpoint, the requirement gate and a normalized outcome, but a
> deliberately smaller body: no `verificationId`, no `methodLabel`, no
> per-field `label`, and section `verified` booleans instead of `required` +
> `checkedFields`. The extras exist because the report phase has not been built
> yet — they were left out rather than stubbed with placeholder values. An
> identity result from the running stack looks like this:
>
> ```json
> {
>   "status": "success",
>   "method": "verify_user_info",
>   "identity": {
>     "fields": [
>       { "field": "nationalId", "status": "matched", "submitted": "123456789" }
>     ],
>     "matchedCount": 9,
>     "incorrectFields": []
>   },
>   "face": { "required": false, "verified": null },
>   "idCard": { "required": false, "verified": null },
>   "liveness": { "required": false, "verified": null }
> }
> ```

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

`GET /api/v1/kyc/artifacts/{handle}` streams stored bytes. There is no static
directory mount — that is the mechanism that keeps biometrics out of public reach
(§29, D8).

**Response `200`** — the raw image, with:

| Header | Value |
|--------|-------|
| `Content-Type` | `image/jpeg` or `image/png`, derived from the stored bytes |
| `Cache-Control` | `no-store, private` |
| `Pragma` | `no-cache` |
| `X-Content-Type-Options` | `nosniff` |

The content type is sniffed from the file's magic number on every read, not taken
from what the caller claimed when storing it and not read from a sidecar that
could drift. A stored artefact whose type cannot be identified is refused rather
than served under a guessed content type.

`no-store` is applied to **every** `/api/` response by middleware rather than per
endpoint. Every API response can carry identity data or a handle that stops
resolving when its artefact expires, so a cached copy would outlive both the data
and the consent to keep it.

**Failure responses**

| Code | HTTP | Message |
|------|------|---------|
| `ARTIFACT_NOT_FOUND` | `404` | That file could not be found. Please upload it again. |
| `ARTIFACT_EXPIRED` | `404` | That file has expired. Please upload it again. |

A malformed handle, an unknown handle and an expired one are all `404`; the
distinction between "not found" and "expired" is only useful to the UI, which can
say "please upload it again" either way. A path traversal attempt is not filtered
— it is unrepresentable, because the handle is validated to a fixed shape and the
filesystem path is never derived from caller input.

**Lifecycle**

Artefacts live in a `0700` directory as `0600` files, named `art_` plus 32 hex
characters, with a configurable TTL (default 900s) and a background sweep
(default every 60s). Reading an expired artefact deletes it immediately rather
than waiting for the next sweep, and a stopped container sweeps and clears on
shutdown so a volume outliving the container holds nothing.
