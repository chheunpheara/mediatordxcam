# Verification Flow

End-to-end product flow, from landing page to report.

---

## 1. Route map

| Route | Page | Phases |
|-------|------|--------|
| `/` | Landing — upload the ID Card | 2 |
| `/id-card` | Verification workspace (3-column) + report | 4, 5, 9 |
| `/id-card/passport` | Passport OCR workspace | 8 |

Two primary pages (§6). `/id-card/passport` exists because API 6 must be reachable
independently of the ID-card journey (§36 Phase 8); it shares the workspace shell.

Unknown routes render a Not Found page. There is no redirect loop and no silent
fallback.

---

## 2. Landing → workspace

```text
  Select / drop file
        │
        ▼
  Client validation (§7)  ─── fail ──▶ inline message, no network call
        │ pass
        ▼
  Object-URL preview
        │
        ▼
  POST /api/v1/kyc/id-card/process
        │
        ▼
  Navigate to /id-card  (processing state continues in background)
```

Client-side validation (§7) is a UX affordance only. The backend repeats every
check — file type, size, readability, minimum resolution — because the client is
not trusted (§11).

Validation messages, verbatim (§7):

| Condition | Message |
|-----------|---------|
| Wrong type | `Please upload a JPG, PNG or WebP image.` |
| Too large | `The image is too large.` |
| Unreadable / below minimum resolution | `The image quality is too low. Please upload a clearer ID Card.` |

Technical exceptions never reach the user; a decode failure in the browser becomes
the resolution message, not `IndexSizeError`.

---

## 3. ID Card processing

```text
bytes ──▶ validate ──▶ TempArtifactStore.handle
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
   CamDX API 5 Khmer ID OCR        FaceService (OpenCV, local)
              │                             │
     structured fields              bbox + crop + quality gate
              └──────────────┬──────────────┘
                             ▼
                  IdCardProcessResponse
```

Failure is a first-class outcome. §12's three cases map to three distinct codes
so the UI can react precisely, and no face is ever fabricated:

| Case | Code | Message |
|------|------|---------|
| No face | `FACE_NOT_DETECTED` | We couldn't detect a face on this ID Card. |
| Multiple faces | `MULTIPLE_FACES_DETECTED` | Multiple faces were detected. Please upload a valid ID Card image. |
| Unclear crop | `FACE_QUALITY_TOO_LOW` | The face image is unclear. Please upload a clearer ID Card. |

---

## 4. Detection is not verification (§13)

The workspace shows two visually distinct things, and they are never conflated:

```text
Column 2 "ID Card Face"                Report section "Face"
─────────────────────────────          ────────────────────────
local OpenCV detection                 CamDigiKey verification
badge: "Local detection —              "✓ Face verification
        not a verification"             successful"
source: local_opencv_detection         source: camdx
```

Enforcement is structural, not editorial (`docs/architecture.md` §5):
`FaceExtraction` has no `verified` or `score` field, so a local detection cannot
be rendered as a verification outcome even by mistake. The only producer of
`face.verified` is the CamDX normalizer.

---

## 5. Requirement-driven input collection (§11)

Selecting a method derives the inputs to collect. Nothing is hard-coded in a
component:

```text
selected method
      │
      ▼
requirement matrix (fetched from GET /verification-methods)
      │
      ├─ userInfo      → editable identity form (Column 3)
      ├─ currentFace   → FaceCapture panel
      ├─ idCard        → satisfied by the upload from `/`
      ├─ liveness      → LivenessFlow panel
      └─ passport      → passport upload (method 6)
      │
      ▼
ready_for_verification   ← derived: all flags satisfied
```

The Verify button reflects this derived state, and the backend re-derives it
independently and rejects with `422 REQUIREMENTS_NOT_MET` plus a `missing` list.

### The six methods

| Method | Name | userInfo | currentFace | idCard | liveness | passport |
|--------|------|:--:|:--:|:--:|:--:|:--:|
| `verify_user_info` | Identity Information | ✔ | | | | |
| `verify_user_info_face` | Identity + Face | ✔ | ✔ | | | |
| `verify_user_info_idcard_face` | Identity + ID Card + Face | ✔ | ✔ | ✔ | | |
| `verify_user_info_idcard_liveness` | Identity + ID Card + Liveness | ✔ | | ✔ | ✔ | |
| `khmer_id_card_ocr` | Read Cambodian ID Card | | | ✔ | | |
| `passport_ocr` | Read Passport | | | | | ✔ |

Changing method never discards already-collected input; it only changes which
inputs remain *required*.

---

## 6. Current face capture (§17)

Applies to methods 2 and 3.

- Two entry paths: `Take Photo` (`getUserMedia`) and `Upload Photo`
- Gate: exactly one face, sufficient resolution, face not cropped at the frame edge
  — validated with the same detector as the ID-card path, so the user sees one
  consistent standard
- Actions: `Retake`, `Remove`, `Replace`
- Verification stays disabled until a valid face exists
- Permission denial, no camera, and insecure-context failures each get a
  user-facing message with the upload path offered as a fallback

---

## 7. Liveness (§18)

Applies to method 4 only. Liveness is a **session**, not an upload — a still image
can never satisfy it.

```text
start session ──▶ Step 1/3  Turn your face left
                     │ capture + submit action
                     ▼
                  Step 2/3  Turn your face right
                     │
                     ▼
                  Step 3/3  Nod your head
                     │
                     ▼
              complete ──▶ livenessSessionRef ──▶ POST /verify (API 4)
```

Shown throughout: camera preview, the single current instruction, a progress
indicator, and per-step capture status. `MockLivenessProvider` simulates this in
`CAMDX_MODE=mock` and is isolated so the real implementation replaces only that
class (§18).

Failure at any step ends the session with `LIVENESS_FAILED`, an explanation, and
a restart action — a fresh session, never a reuse of the failed one.

---

## 8. Verification and report (§24–§27)

```text
POST /verify
      │
      ▼
backend requirement validation
      │
      ▼
CamDXProvider (mock | real)
      │
      ▼
normalizer → KycResult → KycResultResponse
      │
      ▼
report
```

### Status derivation

| Situation | `status` |
|-----------|----------|
| All checked fields matched, all required sections verified | `success` |
| Some checks passed, at least one failed | `partial` |
| No meaningful partial information, or a required section definitively failed | `failed` |
| Transport/auth/timeout fault | HTTP error envelope, not a verification status |

The last row matters: an upstream outage must never be shown to a user as "your
identity was rejected" (§28).

### Report rendering rules (§25)

- Only sections whose `required` is `true` render. Method 1 shows no face or
  liveness section.
- Identity renders as a per-field table of `Field | Status` with matched rows
  carrying a check icon and mismatched rows identified in text — never by colour
  alone (§32).
- Partial results enumerate exactly the mismatching fields (§26); a blanket
  "Verification Failed" is shown only when partial information would be useless.
- Scores, endpoints, HTTP status and upstream text are absent. A developer view is
  available behind `CAMDX_EXPOSE_DEVELOPER_VIEW=true` and is off by default
  (D10).

### Recovery actions (§27)

| Cause | Actions |
|-------|---------|
| Identity mismatch | `Try Again`, `Edit Details` |
| Face mismatch | `Retake Photo` |
| ID Card unreadable | `Upload New Document` |
| Liveness failed | `Restart Liveness` |
| Upstream unavailable | `Try Again` |

Actions are data (`KycResult.actions`), so the report renders whatever recovery
the backend determined is appropriate.

---

## 9. Retry and re-entry semantics

| Action | Effect |
|--------|--------|
| `Edit Details` | Returns to the form; the previous result is cleared |
| `Retake Photo` | Replaces the current face only; identity data is preserved |
| `Upload New Document` | Invalidates the previous document artefact and re-runs processing from `/` |
| `Try Again` | Re-submits the same inputs; a new `verificationId` is issued |

Every path returns to `review_required` or `ready_for_verification`, never
directly to `verifying`. State transitions are validated by the table in
`app/domain/state_machine.ts` (§33), and an illegal transition is a `409`, not a
silent no-op.