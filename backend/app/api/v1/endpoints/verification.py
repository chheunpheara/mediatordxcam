"""Verification method listing and the verify call (§19).

Both application-level APIs from §19 that are not document processing.

`GET /verification-methods` exists so the browser learns what each method needs
from us rather than hard-coding it (§11). `POST /verify` re-derives the same
requirements on the backend and refuses an incomplete request, so the UI's
disabled button is a convenience and never the enforcement (§11).
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import KycServiceDep
from app.domain.enums import RequirementFlag, VerificationMethod
from app.domain.requirements import MethodRequirements, requirements_for
from app.integrations.camdx.verify import VerificationOutcome
from app.schemas.verification import (
    FieldOutcomeResponse,
    IdentityOutcomeResponse,
    MethodRequirementsResponse,
    SectionOutcomeResponse,
    VerificationMethodsResponse,
    VerifyRequest,
    VerifyResponse,
)

router = APIRouter(tags=["verification"])

#: Why a method cannot run yet, keyed by the missing input. Plain language for the
#: method card (§10); never a phase number or an internal note.
_UNAVAILABLE_REASON: dict[RequirementFlag, str] = {
    RequirementFlag.CURRENT_FACE: (
        "This method needs a current photo of your face, which this build does not capture yet."
    ),
    RequirementFlag.LIVENESS: (
        "This method needs a liveness check, which this build does not run yet."
    ),
    RequirementFlag.PASSPORT: (
        "This method needs a passport image, which this build does not read yet."
    ),
}


@router.get(
    "/api/v1/kyc/verification-methods",
    response_model=VerificationMethodsResponse,
    summary="List the six CamDigiKey verification methods and their requirements",
)
async def verification_methods(service: KycServiceDep) -> VerificationMethodsResponse:
    """Return all six methods with the inputs each one requires (§19, §11).

    All six are listed even when three cannot run yet: §9 requires the six
    official methods to be displayed, and hiding the pending ones would make the
    app look like it supports fewer than it does. `available` carries the truth.
    """
    return VerificationMethodsResponse(
        methods=[_to_response(requirements) for requirements in service.list_methods()]
    )


@router.post(
    "/api/v1/kyc/verify",
    response_model=VerifyResponse,
    summary="Verify identity with one of the six CamDigiKey APIs",
)
async def verify(request: VerifyRequest, service: KycServiceDep) -> VerifyResponse:
    """Run one verification method (§19).

    Fails with `REQUIREMENTS_NOT_MET` when the request omits an input the chosen
    method needs, before any upstream call is attempted (§11).
    """
    identity = request.userInformation.as_dict() if request.userInformation else None

    outcome = await service.verify(
        method=request.method,
        identity=identity,
        id_card_ref=request.idCardRef,
        current_face_ref=request.currentFaceRef,
        liveness_ref=request.livenessRef,
    )
    return _to_verify_response(outcome)


def _to_response(requirements: MethodRequirements) -> MethodRequirementsResponse:
    flags = requirements.requires
    return MethodRequirementsResponse(
        method=requirements.method,
        officialName=requirements.official_name,
        label=requirements.user_friendly_label,
        requiresUserInfo=RequirementFlag.USER_INFO in flags,
        requiresCurrentFace=RequirementFlag.CURRENT_FACE in flags,
        requiresIdCard=RequirementFlag.ID_CARD in flags,
        requiresLiveness=RequirementFlag.LIVENESS in flags,
        requiresPassport=RequirementFlag.PASSPORT in flags,
        isOcr=requirements.is_ocr,
        available=requirements.is_satisfiable and not requirements.is_ocr,
        unavailableReason=_reason_for(flags, is_ocr=requirements.is_ocr),
    )


def _reason_for(flags: frozenset[RequirementFlag], *, is_ocr: bool) -> str | None:
    """First blocking reason for a method card, or `None` when it can run."""
    if is_ocr:
        return "This is a document read, not a verification. It runs when you process a document."
    if RequirementFlag.LIVENESS in flags:
        return _UNAVAILABLE_REASON[RequirementFlag.LIVENESS]
    if RequirementFlag.CURRENT_FACE in flags:
        return _UNAVAILABLE_REASON[RequirementFlag.CURRENT_FACE]
    return None


def _to_verify_response(outcome: VerificationOutcome) -> VerifyResponse:
    required = requirements_for(outcome.method).requires
    return VerifyResponse(
        status=outcome.status,
        method=outcome.method,
        identity=IdentityOutcomeResponse(
            fields=[
                FieldOutcomeResponse(
                    field=field.field_name,
                    status=field.status,
                    submitted=field.submitted,
                )
                for field in outcome.identity.values()
            ],
            matchedCount=sum(1 for f in outcome.identity.values() if f.status == "matched"),
            incorrectFields=list(outcome.incorrect_fields),
        ),
        face=SectionOutcomeResponse(
            required=RequirementFlag.CURRENT_FACE in required,
            verified=outcome.face,
        ),
        idCard=SectionOutcomeResponse(
            required=RequirementFlag.ID_CARD in required,
            verified=outcome.id_card,
        ),
        liveness=SectionOutcomeResponse(
            required=RequirementFlag.LIVENESS in required,
            verified=outcome.liveness,
        ),
    )


__all__ = ["VerificationMethod", "router"]
