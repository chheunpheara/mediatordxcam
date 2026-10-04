"""CamDX OCR provider abstraction (§15).

Identity information comes from CamDigiKey API 5 (Khmer ID Card OCR) and API 6
(passport OCR) — never from a local OCR engine. OpenCV is for face detection
only; duplicating OCR locally would produce identity data that the government
never read, which is exactly what §15 forbids.

`CamDxMode.MOCK` returns fixed fixtures. That is not a fallback for real mode:
`real` mode with missing credentials fails at startup (§21), so a production
deployment can never silently serve fixture data.
"""

from __future__ import annotations

import abc
import logging
from typing import TYPE_CHECKING, Protocol

from app.core.errors import AppError, ErrorCode
from app.domain.enums import DocumentType, OcrStatus

if TYPE_CHECKING:  # pragma: no cover
    from app.domain.models import OcrResult

logger = logging.getLogger("camdx.camdx.ocr")


class OcrProvider(abc.ABC):
    """Reads identity fields from a document image.

    Implementations translate an upstream response into `OcrResult`; they must
    never let an upstream error string escape (§28).
    """

    @abc.abstractmethod
    async def read_id_card(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        """Read a Cambodian National ID Card via API 5."""

    @abc.abstractmethod
    async def read_passport(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        """Read a passport via API 6."""


class OcrUpstreamError(AppError):
    """An OCR call failed upstream.

    Carries no upstream text or status. The operator sees the request id; the
    user sees a plain sentence (§28).
    """

    def __init__(self, *, code: ErrorCode = ErrorCode.UPSTREAM_UNAVAILABLE) -> None:
        super().__init__(code)


class CamDxMode(Protocol):
    """Marker protocol documenting the two concrete providers in this package.

    Provided so `build_ocr_provider` has an explicit return contract without
    importing both implementations at module scope.
    """

    name: str


__all__ = [
    "DocumentType",
    "OcrProvider",
    "OcrStatus",
    "OcrUpstreamError",
]
