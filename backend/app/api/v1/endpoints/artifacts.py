"""Temporary artefact retrieval (§29).

`GET /api/v1/kyc/artifacts/{handle}`

The UI needs to *show* the original document and the extracted face. Serving them
requires a route, but it must not become a general file server: the handle is
opaque, the store verifies it, and nothing here can be coerced into reading an
arbitrary path.

Artefacts are returned from an API route rather than a static mount precisely so
that expiry is enforced on every read. A static file server would happily serve a
biometric image hours after it should have been deleted.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Response, status

from app.api.deps import ArtifactStoreDep, current_user
from app.core.errors import AppError, ErrorCode
from app.schemas.common import error_responses

logger = logging.getLogger("camdx.api.artifacts")

router = APIRouter(tags=["kyc"], dependencies=[Depends(current_user)])

#: Correct types for the artefacts this application produces. Mirrors the accept
#: list in `app/services/uploads.py`; a type absent here is refused rather than
#: guessed, so a mis-written store cannot make this route a file server.
_MEDIA_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/png": "image/png",
    "image/webp": "image/webp",
}


@router.get(
    "/api/v1/kyc/artifacts/{handle}",
    summary="Fetch a temporary artefact by opaque handle",
    response_class=Response,
    responses={
        **error_responses(
            status.HTTP_404_NOT_FOUND,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        ),
        status.HTTP_200_OK: {
            "content": {
                "image/jpeg": {},
                "image/png": {},
                "image/webp": {},
            },
            "description": "Raw image bytes. Never cached beyond the artefact TTL.",
        },
    },
)
def get_artifact(handle: str, store: ArtifactStoreDep) -> Response:
    """Return the bytes for an artefact handle.

    Raises:
        ArtifactNotFoundError: if the handle is malformed, unknown or expired —
            which surfaces as 404 with a user-facing message (§28).
    """
    artefact = store.get(handle)

    media_type = _MEDIA_TYPES.get(artefact.media_type)
    if media_type is None:
        # Only images are ever stored. An unknown type means the store was
        # written to incorrectly; refuse rather than guess a content type.
        raise AppError(ErrorCode.ARTIFACT_NOT_FOUND)

    data = artefact.path.read_bytes()
    logger.info("artefact served", extra={"handle": handle, "bytes": len(data)})
    return Response(
        content=data,
        media_type=media_type,
        # `no-store` is applied to every /api/ response by the app middleware; the
        # nosniff header stays here because it is specific to serving raw bytes.
        headers={"X-Content-Type-Options": "nosniff"},
    )
