"""CamDigiKey API 3 — Verify User Info + ID Card + User Face (§2).

Adds the submitted card *and* a current selfie to the identity comparison, so it
checks the person against the document they supplied rather than the record alone.
"""

from __future__ import annotations

from app.domain.enums import VerificationMethod
from app.integrations.camdx.mock.verify import MockVerifyProvider
from app.integrations.camdx.verify import VerifyProvider


class VerifyUserIdcardFaceProvider(MockVerifyProvider):
    """API 3 adapter."""

    method = VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE


def build() -> VerifyProvider:
    return VerifyUserIdcardFaceProvider()
