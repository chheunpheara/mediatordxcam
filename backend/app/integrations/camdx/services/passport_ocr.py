"""CamDigiKey API 6 — Passport OCR (§2).

Supported but not the primary Cambodian ID card journey (§2). Phase 8 wires the
route; the registry entry exists now so the six-API mapping is complete.
"""

from __future__ import annotations

from app.domain.enums import VerificationMethod


class PassportOcrAdapter:
    """API 6 adapter."""

    method = VerificationMethod.PASSPORT_OCR
