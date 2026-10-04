"""Schemas for the verification methods and verify endpoints (§19, §23).

§23's conceptual shape is honoured, with one deliberate omission: there is no
`score`. §24 forbids showing internal score fields and this application has no
administrator view, so exposing one over the wire would create a leak with no
consumer. A real adapter that receives a score maps it to a boolean here.

Sections carry `required` so the report omits the ones a method never used —
API #1 must not render a face section (§25).
"""

from __future__ import annotations

from pydantic import Field

from app.domain.enums import (
    OfficialApiName,
    VerificationMethod,
    VerificationStatus,
)
from app.schemas.common import ApiModel


class MethodRequirementsResponse(ApiModel):
    """What one method needs (§11).

    The booleans are sent rather than only a `missing` list so the UI can build
    its inputs from the configuration instead of branching per method (§11).
    """

    method: VerificationMethod
    officialName: OfficialApiName = Field(description="The verbatim CamDigiKey name (§3).")
    label: str = Field(description="User-friendly name for the method card (§10).")
    requiresUserInfo: bool
    requiresCurrentFace: bool
    requiresIdCard: bool
    requiresLiveness: bool
    requiresPassport: bool
    isOcr: bool = Field(description="True for API 5/6, which `verify` does not execute.")
    #: False when a required input exists in the plan but not in the app yet. The
    #: card stays listed so the six methods are all visible (§9) but cannot be run.
    available: bool
    unavailableReason: str | None = Field(
        default=None,
        description="Plain-language reason this method cannot run yet.",
    )


class VerificationMethodsResponse(ApiModel):
    """All six methods, in API order (§19)."""

    methods: list[MethodRequirementsResponse]


class UserInformation(ApiModel):
    """The nine §14 identity fields as submitted.

    Every field is optional so a partial form still reaches the requirement gate
    and gets `REQUIREMENTS_NOT_MET` with `userInfo` named — rather than being
    rejected by the schema with a message about a missing property.
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

    def as_dict(self) -> dict[str, str]:
        """Flatten to the mapping the adapter compares, blanks dropped."""
        return {name: (value or "").strip() for name, value in self.model_dump().items()}


class VerifyRequest(ApiModel):
    """`POST /api/v1/kyc/verify` input (§19).

    Extra fields are rejected (§30): silently ignoring an unexpected field matters
    most here, where a typo'd `idCardRef` would otherwise be read as "no ID card
    supplied" and reported as a missing input rather than a bad request.
    """

    method: VerificationMethod
    userInformation: UserInformation | None = None
    idCardRef: str | None = Field(default=None, description="Opaque handle; required by API 3/4.")
    currentFaceRef: str | None = Field(default=None, description="Required by API 2/3.")
    livenessRef: str | None = Field(default=None, description="Required by API 4.")


class FieldOutcomeResponse(ApiModel):
    """One identity field's comparison (§23)."""

    field: str
    status: str = Field(description="`matched`, `mismatch` or `not_checked`.")
    submitted: str | None = None


class IdentityOutcomeResponse(ApiModel):
    """Identity comparison result."""

    fields: list[FieldOutcomeResponse]
    matchedCount: int
    incorrectFields: list[str]


class SectionOutcomeResponse(ApiModel):
    """A verified boolean for one optional input, or `None` when not required."""

    required: bool
    verified: bool | None = None


class VerifyResponse(ApiModel):
    """The normalized verification result (§23).

    Note what is absent: no upstream payload, no endpoint, no score (§24).
    """

    status: VerificationStatus
    method: VerificationMethod
    identity: IdentityOutcomeResponse
    face: SectionOutcomeResponse
    idCard: SectionOutcomeResponse
    liveness: SectionOutcomeResponse
