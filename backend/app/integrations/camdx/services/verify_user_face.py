"""CamDigiKey API 2 — Verify User Info + User Face (§2).

Adds a current selfie to the identity comparison. §17 owns the capture UI and
Phase 6 owns the adapter's inputs; until that lands this module is present so the
six-API mapping in §3 is complete, and its method stays unsatisfiable through the
requirement gate rather than being hidden.
"""

from __future__ import annotations

from app.domain.enums import VerificationMethod
from app.integrations.camdx.mock.verify import MockVerifyProvider
from app.integrations.camdx.verify import VerifyProvider


class VerifyUserFaceProvider(MockVerifyProvider):
    """API 2 adapter."""

    method = VerificationMethod.VERIFY_USER_INFO_FACE


def build() -> VerifyProvider:
    return VerifyUserFaceProvider()
