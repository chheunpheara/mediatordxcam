"""KYC service: the application-facing layer over the six CamDigiKey APIs (§3).

Business logic stops here. An endpoint says "verify this method with these
inputs"; this class decides whether the inputs are sufficient (§11), resolves
references to bytes, and hands the call to the adapter for that API. Nothing
above this layer knows a vendor exists, which is what lets `CAMDX_MODE=real`
arrive without a frontend change (§21).

The requirement gate runs *before* any adapter is touched, and it runs on the
backend regardless of what the UI believes. §11 is explicit that frontend
validation alone is never enough, and the failure mode it guards against is
concrete: an unverifiable request would otherwise reach a government API and come
back as an opaque rejection the user cannot act on.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.core.errors import AppError, ErrorCode, RequirementsNotMetError
from app.domain.enums import RequirementFlag, VerificationMethod
from app.domain.requirements import missing_requirements, requirements_for
from app.integrations.camdx.services import build_verify_provider
from app.integrations.camdx.verify import VerificationOutcome, VerifyProvider

if TYPE_CHECKING:  # pragma: no cover
    from app.domain.requirements import MethodRequirements
    from app.services.artifacts import TempArtifactStore

logger = logging.getLogger("camdx.kyc")


class KycService:
    """Validates requirements and dispatches to a CamDigiKey adapter."""

    def __init__(self, store: TempArtifactStore, *, camdx_mode: str = "mock") -> None:
        self._store = store
        self._camdx_mode = camdx_mode

    # -- Methods (§19) ---------------------------------------------------

    def list_methods(self) -> list[MethodRequirements]:
        """The six methods with their requirements (§19, §10).

        Ordered by the plan's API numbering so the UI renders them 1 to 6 without
        a second sort.
        """
        return [requirements_for(m) for m in VerificationMethod]

    # -- Verify (§19) ----------------------------------------------------

    async def verify(
        self,
        *,
        method: VerificationMethod,
        identity: dict[str, str] | None,
        id_card_ref: str | None,
        current_face_ref: str | None,
        liveness_ref: str | None,
    ) -> VerificationOutcome:
        """Run one verification method, or explain why it cannot run yet."""
        self._refuse_ocr_method(method)

        missing = self.missing_requirements(
            method,
            identity=identity,
            id_card_ref=id_card_ref,
            current_face_ref=current_face_ref,
            liveness_ref=liveness_ref,
        )
        if missing:
            raise RequirementsNotMetError(missing=[flag.value for flag in missing])

        provider = self._provider(method)
        outcome = await provider.verify(
            identity=identity or {},
            id_card=self._read(id_card_ref),
            current_face=self._read(current_face_ref),
            liveness=self._read(liveness_ref),
        )
        self._assert_outcome_matches_method(method, outcome)
        return outcome

    def missing_requirements(
        self,
        method: VerificationMethod,
        *,
        identity: dict[str, str] | None,
        id_card_ref: str | None,
        current_face_ref: str | None,
        liveness_ref: str | None,
    ) -> tuple[RequirementFlag, ...]:
        """Expose the gate so the UI can ask the same question we will (§11)."""
        return missing_requirements(
            method,
            identity=identity,
            id_card_ref=id_card_ref,
            current_face_ref=current_face_ref,
            liveness_ref=liveness_ref,
        )

    # -- Internals -------------------------------------------------------

    def _refuse_ocr_method(self, method: VerificationMethod) -> None:
        if requirements_for(method).is_ocr:
            raise AppError(ErrorCode.INVALID_REQUEST)

    def _provider(self, method: VerificationMethod) -> VerifyProvider:
        if self._camdx_mode == "mock":
            return build_verify_provider(method)
        raise NotImplementedError(
            "real-mode verification is not implemented yet; see "
            "docs/camdx-integration.md for the open questions that block it."
        )

    def _read(self, handle: str | None) -> bytes | None:
        """Resolve an opaque artefact handle to bytes.

        The store enforces the TTL (§29), so an expired reference fails here with
        `ARTIFACT_NOT_FOUND` rather than being passed upstream as empty bytes.
        """
        if handle is None:
            return None
        return self._store.read(handle)

    def _assert_outcome_matches_method(
        self, method: VerificationMethod, outcome: VerificationOutcome
    ) -> None:
        """Reject a result that claims a comparison the method never made.

        §25 requires that only relevant sections appear, and a provider reporting
        a face result for API 1 would put `verified: false` on screen for a method
        that has no face — indistinguishable, to the user, from a failed face check.
        """
        required = requirements_for(method).requires
        for flag, value in (
            (RequirementFlag.CURRENT_FACE, outcome.face),
            (RequirementFlag.ID_CARD, outcome.id_card),
            (RequirementFlag.LIVENESS, outcome.liveness),
        ):
            if flag not in required and value is not None:
                raise AppError(ErrorCode.INTERNAL_ERROR)


__all__ = ["KycService"]
