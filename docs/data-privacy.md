# Data Privacy

ID Card images and face images are **highly sensitive biometric data**. This
document is the lifecycle contract referenced by §29.

---

## 1. Classification

| Class | Examples | Handling |
|-------|----------|----------|
| **Biometric** | face image, cropped ID-card face, liveness frames | Temporary only. Never persisted. Never logged. |
| **Document** | ID Card image, passport image | Temporary only. Never logged. Never persisted. |
| **Identity** | national ID, names, DOB, gender | Held in memory for the active session; may be persisted only if a phase introduces a documented record (§29) |
| **Operational** | `requestId`, artefact handles, timings, error codes | Logged freely, with handles redacted |

No class above is written to a Git repository, a static directory, or a log file.

---

## 2. Lifecycle

```text
 ① Select        browser File object, never uploaded yet
       │
 ② Validate      in-browser checks only; still nothing sent
       │
 ③ Transmit      HTTPS → FastAPI; read fully into memory, never to a temp path by the framework
       │
 ④ Store         var/tmp/art_<handle>   opaque handle, restrictive permissions
       │
 ⑤ Process       OCR → CamDX (over HTTPS); face extraction → in-memory crop, then stored as its own artefact
       │
 ⑥ Use           streamed to the browser via the artefact endpoint with Cache-Control: no-store
       │
 ⑦ Expire        swept after TEMP_ARTIFACT_TTL_SECONDS (default 900); unlinking is not deferred to shutdown
```

### ①–③ Before transmission

- Validation happens client-side first so an obviously invalid file never leaves
  the device (§7).
- The preview uses an object URL, revoked on replace and on unmount, so a blob URL
  never lingers in memory or the console.

### ④ Storage

- `TempArtifactStore` writes under `TEMP_STORAGE_DIR` (default `var/tmp`), which
  is **outside** every static path.
- Files are created `0600` inside a `0700` directory.
- The API returns an opaque handle (`art_` + 32 hex characters, from `uuid4`).
  The filesystem path never crosses the API boundary, and the handle is validated
  to that exact shape before it is used, so path traversal is not expressible
  rather than merely rejected.
- The response `Content-Type` is sniffed from the stored bytes on every read, not
  taken from the caller's claim, so a tampered or mislabelled artefact cannot be
  served with a content type that changes how a browser treats it.
- Uploads are not written by the web framework to a spooled temp file with a
  predictable name; the body is read into memory with a hard size cap
  (`MAX_UPLOAD_BYTES`), and the cap is enforced while streaming, before the buffer
  is fully materialised.

### ⑤ Processing

- CamDX receives only the specific artefact an API requires.
- OpenCV extracts a bounding box and crop. **No face embedding is computed,
  stored or transmitted, ever** (§29). Embeddings are not required by any of the
  six APIs and are explicitly out of scope.
- Temporary crops are stored as separate artefacts with the same TTL, not as
  derivatives that outlive their parent.

### ⑥ Use

- Served only by `GET /api/v1/artifacts/{handle}`.
- The response sets `Cache-Control: no-store` so no browser, proxy or CDN retains
  biometric bytes.
- **There is no static mount for user uploads.** This is asserted by an
  integration test — a static mount is a regression, not a configuration choice.

### ⑦ Expiry

- `TEMP_ARTIFACT_TTL_SECONDS` (default 900, max 3600).
- A sweeper task runs every `TEMP_SWEEP_INTERVAL_SECONDS` (default 60) and
  deletes expired artefacts.
- Expiry is also checked on read: an expired handle yields `404 ARTIFACT_EXPIRED`
  even before the sweeper runs, and reading one deletes it immediately rather than
  waiting for the next tick.
- Artefact responses and every `/api/` response carry `Cache-Control: no-store,
  private` and `Pragma: no-cache`. A cached copy would outlive both the artefact and
  the consent to keep it.
- Artefacts become unreachable as soon as the verification reaches a terminal
  state (`success` / `partial` / `failed` / `error`) — the result is retained,
  the images are not.
- `docker compose down` removes the temp volume.

---

## 3. What is never done

| Prohibition | Mechanism |
|-------------|-----------|
| Public static exposure of uploads | No `StaticFiles` mount on user content; integration test asserts it |
| Persistent biometric storage | Artefacts are temp-only; `db.py` has no biometric column and no face-embedding table |
| Face embeddings | Not computed. `FaceDetection` has no embedding field, and the response schema has no place to put one |
| Any face "confidence" or verification claim | The `face` object has no `verified`, `matchScore` or `confidence` field; `quality` is crop sharpness and is documented as such. A Haar cascade cannot produce a meaningful confidence, and naming one would let the UI present a local detection as a government result (§13) |
| Guessing which portrait is the user | Two or more faces yields `face.status = "multiple"` with no crop, rather than picking one |
| Logging images or faces | `logging.py` redacts handles; image bytes are never passed to a logger |
| Logging national IDs / names | Redaction filter on configurable patterns |
| Logging raw CamDX payloads | `client.py` logs status and correlation id only |
| Secrets in the repository | `.env` git-ignored; `.env.example` holds placeholders only; CI greps for credential patterns |
| Secrets in the browser | All CamDX calls are server-side (§30) |
| Sensitive data in browser console | No `console.log` of blobs, handles or payloads; lint rule |
| Sensitive data in URLs | Artefacts are referenced by opaque handle, never by data URL or path |
| Uploads in Git | `.gitignore` covers `var/`, `tests/fixtures/`, `tests/e2e/artifacts/` and `uploads/`. Image fixtures are generated at test time by `tests/fixtures/images.py`, so no biometric-looking binary is committed |

---

## 4. Transport and network

- HTTPS-ready: no code path requires plain HTTP in production, and
  `Secure`/`HttpOnly`/`SameSite` cookies plus HSTS are configured for the
  production profile (Phase 10).
- The browser talks only to our backend over one origin (§30).
- CamDX credentials are read from the process environment at startup, held in
  memory, and never serialised into a response, log, or error.

---

## 5. Logging policy

Allowed in logs:

```text
requestId, route, method, status, duration_ms, camdxMode,
errorCode, providerName, artifactCount, detectionCounts, ocrFieldStatus
```

Never in logs:

```text
national ID, names (Khmer or English), DOB, image bytes,
face crop bytes, artefact filesystem paths, CamDX credentials,
raw upstream bodies, raw user payloads
```

Redaction is implemented as a `logging.Filter` in `app/core/logging.py` and
tested by `tests/unit/test_logging_redaction.py`, which feeds each sensitive
value through the formatter and asserts its absence from the output.

Debug logging of payloads is gated behind `LOG_LEVEL=DEBUG` **and**
`LOG_SENSITIVE_PAYLOADS=true`, which defaults to `false` and is documented as
unsafe for any shared environment.

---

## 6. Access control

- Artefacts are reachable only through their opaque handle.
- Handles are unguessable (UUID4), time-limited, and unbound to any long-lived
  session token.
- Phase 10 adds rate limiting to `id-card/process`, `verify` and the artefact
  endpoint to prevent handle-probing or resource abuse.

This is a prototype without user accounts. That is a deliberate, documented
limitation: there is no authentication layer, so anyone with a handle can read
that artefact until it expires. The mitigation is the short TTL plus
unguessable handles. Adding accounts is the first task if this leaves a
development environment.

---

## 7. Third parties

| Party | Data received | Retention |
|-------|---------------|-----------|
| CamDigiKey | The specific artefact and identity fields an API requires | Governed by the CamDX agreement — must be reviewed before real mode |
| Cloud/hosting | Whatever is deployed there | Operator's responsibility |

Before `CAMDX_MODE=real`, the CamDX data-processing terms must be reviewed: which
artefacts reach their systems, how long they retain them, and whether face data is
used for training. This is recorded as a go-live gate in
`docs/camdx-integration.md` §8.

---

## 8. Checklist before production

- [ ] TLS terminated in front of both frontend and backend
- [ ] Real CamDX data-processing terms reviewed and accepted
- [ ] Secrets sourced from a secret manager, not `.env` on disk
- [ ] `LOG_SENSITIVE_PAYLOADS=false` verified in the deployed environment
- [ ] Artefact TTL and sweeper verified running
- [ ] Access logging enabled with the redaction filter active
- [ ] Data deletion request path implemented for any persisted identity record
- [ ] Incident response contact documented