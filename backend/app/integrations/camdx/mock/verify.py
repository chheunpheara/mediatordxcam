"""Mock verification provider (§21).

Deterministic so the whole verify path is exercisable offline, and unmistakably
fake so nobody mistakes it for a government result — the same rule the mock OCR
follows (§16).

Outcomes are driven by what the caller submits, not by randomness:

* A national ID of `000000000000` produces a `failed` identity with every field
  mismatched. That is the fixture's own marker value, so the failure path is
  reachable without a magic input.
* Any other national ID verifies, and a face or ID Card whose bytes contain
  `MISMATCH` comes back false.

Because the markers are visible in the request, a screenshot of a mock "success"
cannot be mistaken for a real one.
"""

from __future__ import annotations

import logging

from app.domain.enums import VerificationMethod, VerificationStatus
from app.domain.requirements import IDENTITY_FIELD_NAMES
from app.integrations.camdx.verify import FieldOutcome, VerificationOutcome, VerifyProvider

logger = logging.getLogger("camdx.camdx.verify.mock")

#: The fixture's national ID. Same value the mock OCR returns, so a card that
#: OCRs to it is the same card that fails verification.
FIXTURE_NATIONAL_ID = "000000000000"

#: Substring in an artefact's bytes that makes that comparison report false.
MISMATCH_MARKER = b"MISMATCH"


class MockVerifyProvider(VerifyProvider):
    """Fixture-backed verification for all four verification APIs."""

    method: VerificationMethod

    @property
    def name(self) -> str:
        return "mock"

    async def verify(
        self,
        *,
        identity: dict[str, str],
        id_card: bytes | None,
        current_face: bytes | None,
        liveness: bytes | None,
    ) -> VerificationOutcome:
        """Compare each submitted field against the fixture's expectation."""
        national_id = (identity.get("nationalId") or "").strip()
        identity_fails = national_id == FIXTURE_NATIONAL_ID

        outcomes = {
            name: FieldOutcome(
                field_name=name,
                status="mismatch" if identity_fails else "matched",
                submitted=(identity.get(name) or "").strip() or None,
            )
            for name in IDENTITY_FIELD_NAMES
        }

        face = None if current_face is None else not _contains(current_face, MISMATCH_MARKER)
        id_card_ok = None if id_card is None else not _contains(id_card, MISMATCH_MARKER)
        liveness_ok = None if liveness is None else not _contains(liveness, MISMATCH_MARKER)

        status = _status_for(outcomes, face, id_card_ok, liveness_ok)
        logger.info(
            "mock verify",
            extra={"method": self.method.value, "status": status.value, "source": self.name},
        )
        return VerificationOutcome(
            status=status,
            method=self.method,
            identity=outcomes,
            face=face,
            id_card=id_card_ok,
            liveness=liveness_ok,
        )


def _contains(data: bytes | None, marker: bytes) -> bool:
    return data is not None and marker in data


def _status_for(
    outcomes: dict[str, FieldOutcome],
    face: bool | None,
    id_card: bool | None,
    liveness: bool | None,
) -> VerificationStatus:
    """Derive the overall status from the parts.

    Deriving rather than hard-coding removes the possibility of reporting
    `success` while a field is mismatched — the exact contradiction §25 forbids.
    `partial` means some parts failed; `failed` means the identity itself did.
    """
    identity_failed = any(o.status == "mismatch" for o in outcomes.values())
    optional_failed = any(part is False for part in (face, id_card, liveness))

    if identity_failed:
        return VerificationStatus.FAILED
    if optional_failed:
        return VerificationStatus.PARTIAL
    return VerificationStatus.SUCCESS
