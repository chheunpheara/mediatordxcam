"""CamDigiKey API 5 — Khmer ID Card OCR (§2).

The primary entry point of the upload workflow. OCR itself already lives behind
`OcrProvider`; this adapter is the named API-5 slot in the six-API registry (§3),
so `VerificationMethod.KHMER_ID_CARD_OCR` maps to something concrete rather than
to nothing.
"""

from __future__ import annotations

from app.domain.enums import VerificationMethod


class KhmerIdCardOcrAdapter:
    """API 5 adapter. Delegates reads to the configured `OcrProvider`."""

    method = VerificationMethod.KHMER_ID_CARD_OCR
