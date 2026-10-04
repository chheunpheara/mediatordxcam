"""ID-card processing orchestration (§7, §12, §14, §15).

Runs the two independent reads of an uploaded card — CamDX OCR for identity
fields, OpenCV for the portrait — and returns both. They are kept separate
because they are separate facts: one is a government read, the other is a local
measurement (§13).

A failure in either does not hide the other. OCR can succeed while no face is
found, and vice versa; the result reports both and the caller decides what the
user needs to redo.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.core.errors import AppError, ErrorCode
from app.core.ids import new_processing_id
from app.domain.enums import OcrStatus
from app.domain.models import DocumentProcessingResult, OcrResult
from app.services.face import FaceService

if TYPE_CHECKING:  # pragma: no cover
    from app.integrations.camdx.ocr import OcrProvider
    from app.services.artifacts import TempArtifactStore

logger = logging.getLogger("camdx.documents")


class DocumentProcessor:
    """Processes an uploaded ID card into identity fields plus a face crop."""

    def __init__(
        self,
        *,
        ocr: OcrProvider,
        face: FaceService,
        store: TempArtifactStore,
    ) -> None:
        self._ocr = ocr
        self._face = face
        self._store = store

    async def process_id_card(
        self,
        image_bytes: bytes,
        *,
        media_type: str,
    ) -> DocumentProcessingResult:
        """Process a Cambodian National ID Card.

        The uploaded bytes are stored first so the original document can be shown
        back to the user alongside the extracted data (§14, column 1).

        Raises:
            AppError: `OCR_UNREADABLE` when nothing at all could be read.
        """
        artefact = self._store.put(image_bytes, media_type=media_type)

        try:
            ocr_result = await self._read_ocr(image_bytes, media_type=media_type)
        except AppError:
            # The card is on disk and this request is about to fail. Leaving it
            # there would mean every unreadable upload leaves a document behind
            # for the whole TTL, for a result nobody will ever see returned.
            self._store.delete(artefact.handle)
            raise

        if not ocr_result.is_usable:
            self._store.delete(artefact.handle)
            # An unreadable card is a business failure. Returning an empty form
            # would invite the user to type their own national ID, producing a
            # verification request against data no government service read.
            raise AppError(ErrorCode.OCR_UNREADABLE)

        face_detection = self._face.detect(image_bytes)

        logger.info(
            "id card processed",
            extra={
                "ocr_status": ocr_result.status,
                "face_status": str(face_detection.status),
                "document_handle": artefact.handle,
            },
        )
        return DocumentProcessingResult(
            processing_id=new_processing_id(),
            status=ocr_result.status,
            ocr=ocr_result,
            face=face_detection,
            document_artefact_handle=artefact.handle,
            face_artefact_handle=face_detection.face_artefact_handle,
        )

    async def _read_ocr(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        """Call the provider, mapping an unusable read to a business error."""
        result = await self._ocr.read_id_card(image_bytes, media_type=media_type)
        if result.status == OcrStatus.UNREADABLE.value:
            raise AppError(ErrorCode.OCR_UNREADABLE)
        return result
