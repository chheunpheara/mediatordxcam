"""Current-face capture upload (Phase 6).

Accepts a photo of the user's current face (file upload or webcam snapshot),
detects a face with the same OpenCV cascade used for ID-card portraits (§12), and
stores the image as a temporary artefact referenced by an opaque handle. The
handle is what `POST /api/v1/kyc/verify` receives as `currentFaceRef`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile

from app.api.deps import ArtifactStoreDep, FaceServiceDep, SettingsDep, current_user
from app.api.v1.endpoints.id_card import _read_capped
from app.schemas.common import error_responses
from app.schemas.kyc import FaceBoxResponse, FaceCaptureResponse
from app.services.uploads import validate_image_upload

router = APIRouter(tags=["face-capture"], dependencies=[Depends(current_user)])


@router.post(
    "/api/v1/kyc/face-capture",
    response_model=FaceCaptureResponse,
    summary="Capture the current face",
    responses=error_responses(400, 413, 415, 422, 500),
)
async def capture_current_face(
    face: Annotated[UploadFile, File(description="A current photo of the user's face.")],
    settings: SettingsDep,
    face_service: FaceServiceDep,
    store: ArtifactStoreDep,
) -> FaceCaptureResponse:
    """Accept a current-face image, detect a face, and return its handle."""
    data = await _read_capped(face, cap=settings.max_upload_bytes)
    accepted = validate_image_upload(
        data,
        media_type=face.content_type or "application/octet-stream",
        min_width=settings.min_image_width,
        min_height=settings.min_image_height,
    )
    detection = face_service.detect(accepted.data)

    # Stored regardless of detection outcome so the capture flow never loses the
    # uploaded media; `status` tells the client whether a usable face was found.
    stored = store.put(accepted.data, media_type=accepted.media_type)

    return FaceCaptureResponse(
        status=detection.status.value,
        detectedCount=detection.detected_count,
        box=(
            FaceBoxResponse(
                x=detection.box.x,
                y=detection.box.y,
                width=detection.box.width,
                height=detection.box.height,
            )
            if detection.box
            else None
        ),
        faceRef=stored.handle,
        quality=detection.quality,
    )
