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
from app.domain.enums import (
    FieldCheckStatus,
    RequirementFlag,
    VerificationMethod,
)
from app.domain.requirements import missing_requirements, requirements_for
from app.domain.verification import derive_verification_status
from app.integrations.camdx.services import build_verify_provider
from app.integrations.camdx.verify import VerificationOutcome, VerifyProvider
from app.services.face import FaceService
from app.services.identity_registry import DatabaseVerifyProvider, IdentityRegistry

if TYPE_CHECKING:  # pragma: no cover
    from app.domain.requirements import MethodRequirements
    from app.services.artifacts import TempArtifactStore

logger = logging.getLogger("camdx.kyc")


class KycService:
    """Validates requirements and dispatches to a CamDigiKey adapter."""

    def __init__(
        self,
        store: TempArtifactStore,
        *,
        camdx_mode: str = "mock",
        registry: IdentityRegistry | None = None,
    ) -> None:
        self._store = store
        self._camdx_mode = camdx_mode
        self._registry = registry
        self._face_service = FaceService(store)

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
        id_card_face_ref: str | None = None,
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

        required = requirements_for(method).requires
        provider = self._provider(method)
        outcome = await provider.verify(
            identity=identity or {},
            id_card=self._read(id_card_ref) if RequirementFlag.ID_CARD in required else None,
            current_face=self._read(current_face_ref)
            if RequirementFlag.CURRENT_FACE in required
            else None,
            liveness=self._read(liveness_ref) if RequirementFlag.LIVENESS in required else None,
        )
        self._assert_outcome_matches_method(method, outcome)
        return self._verify_sections(
            method,
            outcome,
            required,
            id_card_ref=id_card_ref,
            current_face_ref=current_face_ref,
            id_card_face_ref=id_card_face_ref,
        )

    def _verify_sections(
        self,
        method: VerificationMethod,
        outcome: VerificationOutcome,
        required: frozenset[RequirementFlag],
        *,
        id_card_ref: str | None,
        current_face_ref: str | None,
        id_card_face_ref: str | None,
    ) -> VerificationOutcome:
        """Local compare of the currently-captured face against the ID card face.

        For methods requiring a current face, replace the adapter's face claim with
        an actual local comparison (OpenCV): the ID card's extracted face versus the
        face in the freshly-taken/uploaded photo. The ID-card check and liveness
        keep the adapter outcomes (no live CamDX call in this prototype).
        """
        face_verified = outcome.face
        if RequirementFlag.CURRENT_FACE in required:
            current_bytes = self._read(current_face_ref)
            id_face_handle = id_card_face_ref
            if id_face_handle is None:
                id_card_bytes = self._read(id_card_ref)
                if id_card_bytes is not None:
                    id_face_handle = self._face_service.detect(id_card_bytes).face_artefact_handle
            face_verified = self._face_service.face_match(
                stored_face_handle=id_face_handle,
                current_photo=current_bytes or b"",
            )

        new_face = face_verified if RequirementFlag.CURRENT_FACE in required else None
        new_id_card = outcome.id_card if RequirementFlag.ID_CARD in required else None
        new_liveness = outcome.liveness if RequirementFlag.LIVENESS in required else None

        sections: list[bool | None] = []
        if RequirementFlag.CURRENT_FACE in required:
            sections.append(new_face)
        if RequirementFlag.ID_CARD in required:
            sections.append(new_id_card)
        if RequirementFlag.LIVENESS in required:
            sections.append(new_liveness)

        # The §25-§27 status rule lives in the domain so the fixture provider,
        # the registry and this re-computation cannot drift apart. Identity with
        # *some* fields mismatched is `partial` (§26), not `failed`: a report
        # that can say which fields matched must not be flattened to a refusal.
        field_statuses = {
            name: FieldCheckStatus(field.status) for name, field in outcome.identity.items()
        }
        status = derive_verification_status(field_statuses, sections=sections)

        return VerificationOutcome(
            status=status,
            method=method,
            identity=outcome.identity,
            face=new_face,
            id_card=new_id_card,
            liveness=new_liveness,
        )

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
        if self._camdx_mode != "mock":
            raise NotImplementedError(
                "real-mode verification is not implemented yet; see "
                "docs/camdx-integration.md for the open questions that block it."
            )
        # Precedence (D13): real CamDX (above, once wired) > registry > fixtures.
        # The registry check comes second on purpose — with `CAMDX_MODE=real`
        # nothing may quietly answer in CamDigiKey's place (§21).
        if self._registry is not None:
            return DatabaseVerifyProvider(method, self._registry)
        return build_verify_provider(method)

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
