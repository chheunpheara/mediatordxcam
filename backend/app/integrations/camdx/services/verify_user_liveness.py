"""CamDigiKey API 4 — Verify User Info + ID Card Image + Liveness (§2).

Substitutes a liveness interaction for the current selfie. §18 defines the
action workflow and Phase 7 implements it; `:1355` requires that API 4 cannot
execute without liveness state, so this adapter stays unreachable until then.
"""

from __future__ import annotations

from app.domain.enums import VerificationMethod
from app.integrations.camdx.mock.verify import MockVerifyProvider
from app.integrations.camdx.verify import VerifyProvider


class VerifyUserLivenessProvider(MockVerifyProvider):
    """API 4 adapter."""

    method = VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS


def build() -> VerifyProvider:
    return VerifyUserLivenessProvider()
