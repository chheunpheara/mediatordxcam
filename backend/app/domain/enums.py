"""Core domain vocabulary.

Pure types only — no I/O, no FastAPI, no settings. Everything here is
unit-testable without a single mock, which is what makes the requirement engine
(§11) and the state machine (§33) trustworthy.

Method ids are the snake_case of the official CamDigiKey API names (§3, D3), so
internal code never drifts from the documented API.
"""

from __future__ import annotations

from enum import StrEnum


class VerificationMethod(StrEnum):
    """The six CamDigiKey KYC APIs this application supports (§2).

    Each member maps 1:1 to one adapter module in
    `app/integrations/camdx/services/`. No seventh value may be added.
    """

    #: API 1 — Verify User Info
    VERIFY_USER_INFO = "verify_user_info"
    #: API 2 — Verify User Info + User Face
    VERIFY_USER_INFO_FACE = "verify_user_info_face"
    #: API 3 — Verify User Info + ID Card + User Face
    VERIFY_USER_INFO_IDCARD_FACE = "verify_user_info_idcard_face"
    #: API 4 — Verify User Info + ID Card Image + Liveness
    VERIFY_USER_INFO_IDCARD_LIVENESS = "verify_user_info_idcard_liveness"
    #: API 5 — Khmer ID Card OCR
    KHMER_ID_CARD_OCR = "khmer_id_card_ocr"
    #: API 6 — Passport OCR
    PASSPORT_OCR = "passport_ocr"


class OfficialApiName(StrEnum):
    """Verbatim CamDigiKey API names.

    Kept as a separate enum from `VerificationMethod` so the internal id and the
    official name can never be conflated, and so the official wording is rendered
    verbatim wherever it is displayed (§3).
    """

    VERIFY_USER_INFO = "Verify User Info"
    VERIFY_USER_INFO_FACE = "Verify User Info + User Face"
    VERIFY_USER_INFO_IDCARD_FACE = "Verify User Info + ID Card + User Face"
    VERIFY_USER_INFO_IDCARD_LIVENESS = "Verify User Info + ID Card Image + Liveness"
    KHMER_ID_CARD_OCR = "Khmer ID Card OCR"
    PASSPORT_OCR = "Passport OCR"


class RequirementFlag(StrEnum):
    """Names of the inputs a method can require (§11).

    These strings appear in the `missing` list of a `REQUIREMENTS_NOT_MET`
    response, so the frontend branches on them rather than parsing prose.
    """

    USER_INFO = "userInfo"
    CURRENT_FACE = "currentFace"
    ID_CARD = "idCard"
    LIVENESS = "liveness"
    PASSPORT = "passport"


class DocumentType(StrEnum):
    """Supported identity documents."""

    KHMER_ID_CARD = "khmer_id_card"
    PASSPORT = "passport"


class VerificationStatus(StrEnum):
    """Terminal outcome of a verification run (§25, §26, §27).

    Note that a *negative verification is not an error*. A mismatch is a
    successful API call whose result is `partial` or `failed`. HTTP errors are
    reserved for malformed or unprocessable requests (§28).
    """

    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"


class VerificationSection(StrEnum):
    """Sections of a verification result. Only `required` ones are rendered (§25)."""

    IDENTITY = "identity"
    FACE = "face"
    ID_CARD = "idCard"
    LIVENESS = "liveness"
    OCR = "ocr"


class FieldCheckStatus(StrEnum):
    """Per-field comparison outcome for identity data (§26).

    `not_checked` is distinct from `mismatch` on purpose: a field CamDX omitted
    was never verified, so it must never render as a failure.
    """

    MATCHED = "matched"
    MISMATCH = "mismatch"
    NOT_CHECKED = "not_checked"


class FaceExtractionStatus(StrEnum):
    """Outcome of local OpenCV face detection (§12).

    These describe *detection*, never verification (§13).
    """

    DETECTED = "detected"
    NOT_DETECTED = "not_detected"
    MULTIPLE = "multiple"
    LOW_QUALITY = "low_quality"


class FaceSource(StrEnum):
    """Where a face claim originates (§13).

    A local extraction is never `CAMDX`; the two are structurally distinct.
    """

    #: Local OpenCV detection and crop from an ID card. Not a verification.
    LOCAL_DETECTION = "local_opencv_detection"
    #: CamDigiKey face verification. The only source of a verification claim.
    CAMDX = "camdx"
    NOT_REQUIRED = "not_required"


class OcrStatus(StrEnum):
    """Outcome of an OCR request through API 5 or API 6."""

    COMPLETED = "completed"
    PARTIAL = "partial"
    UNREADABLE = "unreadable"


class WorkflowState(StrEnum):
    """Client workflow states (§33).

    The legal transitions between these are defined in
    `app/domain/state_machine.py` and mirrored in the frontend. An illegal
    transition is rejected, never silently ignored.
    """

    IDLE = "idle"
    UPLOADING = "uploading"
    PROCESSING = "processing"
    OCR_COMPLETED = "ocr_completed"
    FACE_DETECTED = "face_detected"
    REVIEW_REQUIRED = "review_required"
    READY_FOR_VERIFICATION = "ready_for_verification"
    COLLECTING_FACE = "collecting_face"
    COLLECTING_LIVENESS = "collecting_liveness"
    VERIFYING = "verifying"
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
