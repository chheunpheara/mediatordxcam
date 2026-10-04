"""Domain value objects.

Pure types only: no I/O, no FastAPI, no settings, no OpenCV. Everything here is
constructible and assertable in a unit test without a single mock, which is what
makes the requirement engine (§11) and these results trustworthy.

Two boundaries are enforced by *shape*, not by convention:

* `IdentityData` has no `verified` or `score`. OCR extraction is not a
  verification claim (§13, §16).
* `FaceDetection` carries a `source` that can only be
  `local_opencv_detection`, never CamDX. A local detection cannot be mistaken
  for a government-side verification because there is no field in which to say so.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.domain.enums import DocumentType, FaceExtractionStatus, FaceSource


@dataclass(frozen=True, slots=True)
class IdentityData:
    """Identity fields read from a document.

    Every field is optional and defaults to `None` meaning *not extracted*. That
    is materially different from an empty string and from a wrong value: §16
    requires an unextracted field to be left for the user to complete, never
    guessed. `None` is the only representation of "OCR did not read this".
    """

    national_id: str | None = None
    first_name_khmer: str | None = None
    last_name_khmer: str | None = None
    first_name_english: str | None = None
    last_name_english: str | None = None
    date_of_birth: str | None = None
    gender: str | None = None
    issued_date: str | None = None
    expiry_date: str | None = None

    @property
    def extracted_fields(self) -> dict[str, str]:
        """Only the fields OCR actually produced, keyed by API field name."""
        return {
            name: value
            for name, value in (
                ("nationalId", self.national_id),
                ("firstNameKhmer", self.first_name_khmer),
                ("lastNameKhmer", self.last_name_khmer),
                ("firstNameEnglish", self.first_name_english),
                ("lastNameEnglish", self.last_name_english),
                ("dateOfBirth", self.date_of_birth),
                ("gender", self.gender),
                ("issuedDate", self.issued_date),
                ("expiryDate", self.expiry_date),
            )
            if value is not None
        }

    @property
    def is_empty(self) -> bool:
        """True when nothing at all was extracted."""
        return not self.extracted_fields


@dataclass(frozen=True, slots=True)
class OcrResult:
    """Outcome of an OCR read through API 5 or API 6.

    `document_type` records what the OCR believed it was reading, so a passport
    submitted to the ID-card flow is detectable rather than silently mis-parsed.
    """

    status: str
    identity: IdentityData
    document_type: DocumentType | None = None
    #: Fields OCR could not read. The UI prompts for these (§16).
    missing_fields: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_usable(self) -> bool:
        """True when at least one field was read.

        An unreadable document is a business error, not an empty form: telling a
        user to type their own national ID because the scan failed would invite
        them to submit an unverifiable request.
        """
        return not self.identity.is_empty


@dataclass(frozen=True, slots=True)
class FaceBox:
    """Bounding box in pixel coordinates of the original image."""

    x: int
    y: int
    width: int
    height: int

    @property
    def area(self) -> int:
        return self.width * self.height


@dataclass(frozen=True, slots=True)
class FaceDetection:
    """Outcome of local OpenCV face detection on an ID card (§12).

    Carries no `verified` and no `score`: detection is a local measurement, and
    §13 forbids presenting it as a KYC result. `quality` describes the crop for
    the user's benefit (is it clear enough to be worth continuing with), not a
    match against anything.
    """

    status: FaceExtractionStatus
    source: FaceSource = FaceSource.LOCAL_DETECTION
    box: FaceBox | None = None
    #: Handle to the cropped face image. `None` unless a face was detected.
    face_artefact_handle: str | None = None
    #: 0 to 1 clarity of the detected crop, used only to reject an unusable image.
    quality: float | None = None
    #: How many faces were found, so "multiple" can be distinguished from "none".
    detected_count: int = 0

    @property
    def has_face(self) -> bool:
        """True only for a usable, single, clear face."""
        return self.status is FaceExtractionStatus.DETECTED


@dataclass(frozen=True, slots=True)
class DocumentProcessingResult:
    """Combined output of `POST /api/v1/kyc/id-card/process` (§7, §14).

    `status` is the processing outcome and is independent of verification: a
    successful process can still lead to a failed or partial verification later.
    """

    processing_id: str
    status: str
    ocr: OcrResult
    face: FaceDetection
    document_artefact_handle: str
    face_artefact_handle: str | None = None
