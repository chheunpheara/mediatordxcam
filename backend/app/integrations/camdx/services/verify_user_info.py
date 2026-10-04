"""CamDigiKey API 1 — Verify User Info (§2).

Compares submitted identity information against the government record. Needs no
image at all, which is why it is the only verification method runnable before the
face and liveness phases.
"""

from __future__ import annotations

from app.domain.enums import VerificationMethod
from app.integrations.camdx.mock.verify import MockVerifyProvider
from app.integrations.camdx.verify import VerifyProvider


class VerifyUserInfoProvider(MockVerifyProvider):
    """API 1 adapter."""

    method = VerificationMethod.VERIFY_USER_INFO


def build() -> VerifyProvider:
    return VerifyUserInfoProvider()
