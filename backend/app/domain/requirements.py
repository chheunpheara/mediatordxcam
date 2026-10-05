"""The verification requirement engine (§11).

One table maps each of the six CamDigiKey APIs (§2) to the inputs it needs. It is
the single source of truth for three consumers:

* `GET /api/v1/kyc/verification-methods` tells the UI what each method requires
  (§19), so the browser never hard-codes requirements (§11).
* `POST /api/v1/kyc/verify` validates the request against the same table before
  calling any adapter. The backend validates independently and never trusts the
  frontend's disabled button (§11).
* The method cards in the workspace are rendered from it, so "additional inputs
  appear automatically" (§11) needs no per-method UI code.

The table is derived from the official API list rather than hand-copied into the
adapters, because a requirement that exists in an adapter but not here would let
the UI offer a method the backend then refuses.

`USER_INFO` is satisfied by the nine §14 identity fields being non-empty. The
other flags correspond to references the caller must supply.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.enums import OfficialApiName, RequirementFlag, VerificationMethod

#: The nine fields §14 puts on the editable form, in plan order.
IDENTITY_FIELD_NAMES: tuple[str, ...] = (
    "nationalId",
    "firstNameKhmer",
    "lastNameKhmer",
    "firstNameEnglish",
    "lastNameEnglish",
    "gender",
    "dateOfBirth",
    "issuedDate",
    "expiryDate",
)


@dataclass(frozen=True, slots=True)
class MethodRequirements:
    """What one method needs before it can run (§11).

    `owner_phase` records which phase introduces the missing input, so a method
    that cannot yet be satisfied can say *why* rather than looking broken. It is
    never sent to the browser as a phase number — that is an implementation
    detail — but it is used to build the operator-facing explanation.
    """

    method: VerificationMethod
    official_name: OfficialApiName
    user_friendly_label: str
    requires: frozenset[RequirementFlag]
    #: True for the two OCR APIs. They are CamDigiKey operations but they are not
    #: `verify` operations, so `POST /verify` refuses them.
    is_ocr: bool = False
    #: Phase that introduces each currently-unsatisfiable input.
    introduced_in: tuple[str, ...] = ()

    @property
    def is_satisfiable(self) -> bool:
        """True when every required input exists in the application today."""
        return not self.introduced_in


def _requirements(
    method: VerificationMethod,
    official_name: OfficialApiName,
    label: str,
    *requires: RequirementFlag,
    is_ocr: bool = False,
    introduced_in: tuple[str, ...] = (),
) -> MethodRequirements:
    return MethodRequirements(
        method=method,
        official_name=official_name,
        user_friendly_label=label,
        requires=frozenset(requires),
        is_ocr=is_ocr,
        introduced_in=introduced_in,
    )


#: The six official methods (§2). Exactly six — §3 forbids inventing or renaming.
METHOD_REQUIREMENTS: dict[VerificationMethod, MethodRequirements] = {
    VerificationMethod.VERIFY_USER_INFO: _requirements(
        VerificationMethod.VERIFY_USER_INFO,
        OfficialApiName.VERIFY_USER_INFO,
        "Identity Information",
        RequirementFlag.USER_INFO,
    ),
    VerificationMethod.VERIFY_USER_INFO_FACE: _requirements(
        VerificationMethod.VERIFY_USER_INFO_FACE,
        OfficialApiName.VERIFY_USER_INFO_FACE,
        "Identity + Face",
        RequirementFlag.USER_INFO,
        RequirementFlag.CURRENT_FACE,
    ),
    VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE: _requirements(
        VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE,
        OfficialApiName.VERIFY_USER_INFO_IDCARD_FACE,
        "Identity + ID Card + Face",
        RequirementFlag.USER_INFO,
        RequirementFlag.ID_CARD,
        RequirementFlag.CURRENT_FACE,
    ),
    VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS: _requirements(
        VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS,
        OfficialApiName.VERIFY_USER_INFO_IDCARD_LIVENESS,
        "Identity + ID Card + Liveness",
        RequirementFlag.USER_INFO,
        RequirementFlag.ID_CARD,
        RequirementFlag.LIVENESS,
        introduced_in=("liveness",),
    ),
    VerificationMethod.KHMER_ID_CARD_OCR: _requirements(
        VerificationMethod.KHMER_ID_CARD_OCR,
        OfficialApiName.KHMER_ID_CARD_OCR,
        "Read Cambodian ID Card",
        RequirementFlag.ID_CARD,
        is_ocr=True,
    ),
    VerificationMethod.PASSPORT_OCR: _requirements(
        VerificationMethod.PASSPORT_OCR,
        OfficialApiName.PASSPORT_OCR,
        "Read Passport",
        RequirementFlag.PASSPORT,
        is_ocr=True,
        introduced_in=("passport capture",),
    ),
}

#: The four methods `POST /verify` can execute (§19). The two OCR APIs are
#: reachable through their own document flows, not through `verify`.
VERIFICATION_METHODS: tuple[VerificationMethod, ...] = tuple(
    m for m in VerificationMethod if not METHOD_REQUIREMENTS[m].is_ocr
)


def requirements_for(method: VerificationMethod) -> MethodRequirements:
    """Look up a method's requirements. Every enum member is in the table."""
    return METHOD_REQUIREMENTS[method]


def missing_requirements(
    method: VerificationMethod,
    *,
    identity: dict[str, str] | None,
    id_card_ref: str | None,
    current_face_ref: str | None,
    liveness_ref: str | None,
) -> tuple[RequirementFlag, ...]:
    """Which required inputs the caller did not supply (§11).

    Returns flags, not prose, so the frontend can branch on them instead of
    parsing a message (`RequirementFlag` exists for exactly this).

    An identity counts as supplied only when all nine §14 fields are non-empty.
    A form with a national ID but no date of birth is not "user info supplied" —
    accepting it would send an incomplete identity to a government API and let the
    response come back as a failure the user cannot act on.
    """
    supplied: dict[RequirementFlag, bool] = {
        RequirementFlag.USER_INFO: identity is not None
        and all((identity.get(name) or "").strip() for name in IDENTITY_FIELD_NAMES),
        RequirementFlag.ID_CARD: bool(id_card_ref),
        RequirementFlag.CURRENT_FACE: bool(current_face_ref),
        RequirementFlag.LIVENESS: bool(liveness_ref),
        # A passport requirement is never satisfiable here: passport capture is
        # Phase 8, and an empty ref must not read as "supplied".
        RequirementFlag.PASSPORT: False,
    }
    required = requirements_for(method).requires
    return tuple(flag for flag in RequirementFlag if flag in required and not supplied[flag])
