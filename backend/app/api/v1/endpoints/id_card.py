"""ID-card processing endpoint (§7, §14).

`POST /api/v1/kyc/id-card/process`

Accepts a single JPEG/PNG, validates it, runs OCR and local face detection, and
returns extracted identity fields plus a face handle. No image bytes are returned
inline and no filesystem path leaves the process (§29).
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile, status

from app.api.deps import DocumentProcessorDep, SettingsDep, current_user
from app.core.errors import AppError, ErrorCode
from app.schemas.common import error_responses
from app.schemas.kyc import (
    FaceBoxResponse,
    FaceExtractionResponse,
    IdentityFields,
    IdentityResponse,
    ProcessIdCardResponse,
)
from app.services.uploads import validate_image_upload

logger = logging.getLogger("camdx.api.id_card")

router = APIRouter(tags=["kyc"], dependencies=[Depends(current_user)])


@router.post(
    "/api/v1/kyc/id-card/process",
    response_model=ProcessIdCardResponse,
    status_code=status.HTTP_200_OK,
    summary="Process an uploaded Cambodian ID Card",
    responses=error_responses(
        status.HTTP_400_BAD_REQUEST,
        status.HTTP_413_CONTENT_TOO_LARGE,
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        status.HTTP_500_INTERNAL_SERVER_ERROR,
    ),
)
async def process_id_card(
    document: Annotated[UploadFile, File(description="JPEG or PNG ID Card image.")],
    settings: SettingsDep,
    processor: DocumentProcessorDep,
) -> ProcessIdCardResponse:
    """Read identity fields and extract the portrait from an uploaded ID card.

    OCR and face detection are independent: a card whose portrait cannot be
    detected still returns its identity fields, and vice versa.
    """
    if document.content_type is None:
        raise AppError(ErrorCode.UNSUPPORTED_IMAGE_TYPE)

    data = await _read_capped(document, cap=settings.max_upload_bytes)
    accepted = validate_image_upload(
        data,
        media_type=document.content_type,
        min_width=settings.min_image_width,
        min_height=settings.min_image_height,
    )

    result = await processor.process_id_card(accepted.data, media_type=accepted.media_type)

    face = result.face
    return ProcessIdCardResponse(
        processingId=result.processing_id,
        status=result.status,
        ocr=IdentityResponse(
            status=result.ocr.status,
            documentType=(result.ocr.document_type.value if result.ocr.document_type else None),
            fields=IdentityFields(
                nationalId=result.ocr.identity.national_id,
                firstNameKhmer=result.ocr.identity.first_name_khmer,
                lastNameKhmer=result.ocr.identity.last_name_khmer,
                firstNameEnglish=result.ocr.identity.first_name_english,
                lastNameEnglish=result.ocr.identity.last_name_english,
                dateOfBirth=result.ocr.identity.date_of_birth,
                gender=result.ocr.identity.gender,
                issuedDate=result.ocr.identity.issued_date,
                expiryDate=result.ocr.identity.expiry_date,
            ),
            missingFields=list(result.ocr.missing_fields),
        ),
        face=FaceExtractionResponse(
            status=face.status.value,
            source=face.source.value,
            detectedCount=face.detected_count,
            box=(
                FaceBoxResponse(
                    x=face.box.x,
                    y=face.box.y,
                    width=face.box.width,
                    height=face.box.height,
                )
                if face.box
                else None
            ),
            faceRef=face.face_artefact_handle,
            quality=face.quality,
        ),
        documentRef=result.document_artefact_handle,
    )


async def _read_capped(document: UploadFile, *, cap: int) -> bytes:
    """Read the upload, refusing anything over `cap`.

    Read in chunks so an oversized body is rejected without ever being fully
    buffered. Exceeding the cap mid-stream raises rather than truncating, since a
    truncated JPEG is not a valid JPEG.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await document.read(_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            raise AppError(ErrorCode.IMAGE_TOO_LARGE)
        chunks.append(chunk)

    if not chunks:
        raise AppError(ErrorCode.IMAGE_UNREADABLE)
    return b"".join(chunks)


_CHUNK_BYTES = 64 * 1024
