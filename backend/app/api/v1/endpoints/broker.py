"""Broker intake for liveness videos (§7-adjacent; Phase 7).

The customer display page uploads its recorded webm/mp4 here after the
3-second loop. The current build has no broker liveness provider, so this
endpoint stores the blob as an artifact and returns the opaque handle —
the same shape the provider adapter will return once it lands.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, UploadFile

from app.api.deps import ArtifactStoreDep, SettingsDep
from app.api.v1.endpoints.id_card import _read_capped
from app.core.errors import AppError, ErrorCode
from app.schemas.onboarding import VerifyLivenessResponse

router = APIRouter(tags=["broker"])

#: Exactly what a browser's MediaRecorder produces for this flow, and exactly
#: what the artefact route will serve back — a type stored but not servable
#: would hand the teller a handle nobody can open.
ALLOWED_VIDEO = frozenset({"video/webm", "video/mp4"})


@router.post(
    "/api/broker/verify-liveness",
    response_model=VerifyLivenessResponse,
    status_code=201,
    summary="Upload the liveness recording from the customer display",
)
async def verify_liveness(
    liveness_video: Annotated[UploadFile, File(description="webm or mp4 blob")],
    settings: SettingsDep,
    store: ArtifactStoreDep,
) -> VerifyLivenessResponse:
    media_type = (liveness_video.content_type or "").split(";")[0].strip().lower()
    if media_type not in ALLOWED_VIDEO:
        raise AppError(
            ErrorCode.UNSUPPORTED_VIDEO_TYPE,
            message="Liveness video must be a webm or mp4 recording.",
        )
    data = await _read_capped(liveness_video, cap=settings.max_upload_bytes)
    if len(data) == 0:
        raise AppError(ErrorCode.INVALID_REQUEST, message="Liveness recording is empty.")
    stored = store.put(data, media_type=media_type)
    return VerifyLivenessResponse(livenessRef=stored.handle)
