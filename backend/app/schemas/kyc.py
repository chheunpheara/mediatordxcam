"""Schemas for ID-card processing (§7, §14).

The response shape is deliberately narrower than the domain objects. In
particular `identity` carries extracted values and nothing else — no `matched`,
no `score`, no `verified` — because nothing has been verified at this point and a
field name that could later hold a verification claim invites one (§13).

Field names are camelCase on the wire and snake_case internally; the two are kept
apart so an internal rename cannot silently change the public contract.
"""

from __future__ import annotations

from pydantic import Field

from app.domain.enums import FaceExtractionStatus
from app.schemas.common import ApiModel


class IdentityFields(ApiModel):
    """Identity fields as read by OCR.

    The nine fields are exactly those listed in §14, in that order: Khmer ID
    cards carry a name in both scripts, so the four name fields are separate
    values rather than one transliterated pair.

    Each field is nullable and `None` means "not extracted" (§16). The UI shows
    "Please enter this information." for those rather than a blank or a guess.
    """

    nationalId: str | None = None
    firstNameKhmer: str | None = None
    lastNameKhmer: str | None = None
    firstNameEnglish: str | None = None
    lastNameEnglish: str | None = None
    gender: str | None = None
    dateOfBirth: str | None = None
    issuedDate: str | None = None
    expiryDate: str | None = None


class IdentityResponse(ApiModel):
    """OCR outcome for the submitted document."""

    status: str = Field(description="`completed` or `partial`.")
    documentType: str | None = Field(default=None, description="What OCR read it as.")
    fields: IdentityFields
    missingFields: list[str] = Field(
        default_factory=list,
        description="Fields OCR could not read; the UI prompts for these (§16).",
    )


class FaceBoxResponse(ApiModel):
    """Bounding box in pixels of the original image."""

    x: int
    y: int
    width: int
    height: int


class FaceExtractionResponse(ApiModel):
    """Local face detection outcome.

    Note the absence of `verified` and `score`. `quality` describes crop clarity
    only. `source` is always `local_opencv_detection` — present so the client
    never has to infer that this is not a CamDX result (§13).
    """

    status: str = Field(description=f"One of {[s.value for s in FaceExtractionStatus]}.")
    source: str = Field(description="Always `local_opencv_detection`.")
    detectedCount: int = Field(description="How many faces were found.")
    box: FaceBoxResponse | None = None
    #: Opaque handle to the cropped face. Fetch it through the artefact endpoint;
    #: image bytes are never inlined here.
    faceRef: str | None = None
    quality: float | None = Field(default=None, description="Crop clarity, not a match score.")


class ProcessIdCardResponse(ApiModel):
    """Output of `POST /api/v1/kyc/id-card/process`."""

    processingId: str
    status: str = Field(description="`completed` or `partial`.")
    ocr: IdentityResponse
    face: FaceExtractionResponse
    #: Opaque handle to the stored original, for the document column (§14).
    documentRef: str


class FaceCaptureResponse(ApiModel):
    """Output of `POST /api/v1/kyc/face-capture`."""

    status: str = Field(description=f"One of {[s.value for s in FaceExtractionStatus]}.")
    detectedCount: int
    box: FaceBoxResponse | None = None
    #: Opaque handle for the captured current face artefact.
    faceRef: str
    quality: float | None = Field(default=None, description="Crop clarity, not a match score.")
