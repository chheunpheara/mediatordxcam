"""Error taxonomy.

Every error the user can encounter is a *business* code with a message written
for a person, not a developer (§28). Technical upstream failures are translated
here; nothing above this module may emit a raw upstream string.

Three layers, deliberately separated:

```text
upstream fault ──▶ camdx/exceptions.py ──▶ camdx/errors.py
                                              │
                                              ▼
                                      AppError (this module)
                                              │
                                              ▼
                                   api error envelope + HTTP status
```
"""

from __future__ import annotations

import logging
from enum import StrEnum
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("camdx.errors")


class ErrorCode(StrEnum):
    """Stable, business-meaningful error codes.

    These are part of the frontend's contract: the UI branches on `code`, never
    on message text. No entry here is an HTTP status or a vendor code (§28).
    """

    # -- Request shape -----------------------------------------------------
    INVALID_REQUEST = "INVALID_REQUEST"
    NOT_FOUND = "NOT_FOUND"
    UNSUPPORTED_IMAGE_TYPE = "UNSUPPORTED_IMAGE_TYPE"
    IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE"
    IMAGE_UNREADABLE = "IMAGE_UNREADABLE"
    IMAGE_TOO_LOW_RESOLUTION = "IMAGE_TOO_LOW_RESOLUTION"

    # -- Requirement validation (§11) --------------------------------------
    REQUIREMENTS_NOT_MET = "REQUIREMENTS_NOT_MET"
    INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION"

    # -- Authentication / authorization (D18) ------------------------------
    UNAUTHENTICATED = "UNAUTHENTICATED"
    FORBIDDEN = "FORBIDDEN"

    # -- Face handling (§12, §13) ------------------------------------------
    FACE_NOT_DETECTED = "FACE_NOT_DETECTED"
    MULTIPLE_FACES_DETECTED = "MULTIPLE_FACES_DETECTED"
    FACE_QUALITY_TOO_LOW = "FACE_QUALITY_TOO_LOW"
    FACE_CAPTURE_INVALID = "FACE_CAPTURE_INVALID"

    # -- Documents (§15, §16) ----------------------------------------------
    OCR_UNREADABLE = "OCR_UNREADABLE"
    DOCUMENT_TYPE_NOT_SUPPORTED = "DOCUMENT_TYPE_NOT_SUPPORTED"

    # -- Verification outcomes surfaced as errors --------------------------
    IDENTITY_NOT_VERIFIED = "IDENTITY_NOT_VERIFIED"
    FACE_NOT_VERIFIED = "FACE_NOT_VERIFIED"
    ID_CARD_NOT_VERIFIED = "ID_CARD_NOT_VERIFIED"
    LIVENESS_FAILED = "LIVENESS_FAILED"

    # -- Artefacts (§29) ---------------------------------------------------
    ARTIFACT_NOT_FOUND = "ARTIFACT_NOT_FOUND"
    ARTIFACT_EXPIRED = "ARTIFACT_EXPIRED"

    # -- Upstream / infrastructure (§28) -----------------------------------
    UPSTREAM_AUTH_FAILED = "UPSTREAM_AUTH_FAILED"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    UPSTREAM_UNAVAILABLE = "UPSTREAM_UNAVAILABLE"
    UPSTREAM_BAD_RESPONSE = "UPSTREAM_BAD_RESPONSE"

    # -- Configuration / catch-all ----------------------------------------
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


#: Human-readable message per code. A single source of truth so a code can never
#: appear with two different sentences in two different endpoints (§25, §27).
USER_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.INVALID_REQUEST: "Something went wrong with that request. Please try again.",
    ErrorCode.NOT_FOUND: "That page could not be found.",
    # The four upload messages are byte-for-byte the ones the browser shows
    # (`frontend/src/features/document-upload/validation.ts`). Both layers reject
    # the same problems, so a user who reads "Invalid file type" in the file
    # picker must not then be told a different thing by the server — and neither
    # may name a format we do not accept.
    ErrorCode.UNSUPPORTED_IMAGE_TYPE: "Please upload a JPG, PNG or WebP image.",
    ErrorCode.IMAGE_TOO_LARGE: "File is too large. Maximum size is 10 MB.",
    ErrorCode.IMAGE_UNREADABLE: "File is corrupted or cannot be read as an image.",
    # Placeholders are filled in by the caller from the configured limits, so this
    # text cannot drift away from `min_image_width` / `min_image_height`.
    ErrorCode.IMAGE_TOO_LOW_RESOLUTION: (
        "Image is too small. Minimum resolution is {min_width} \u00d7 {min_height} pixels."
    ),
    ErrorCode.REQUIREMENTS_NOT_MET: "Some required information is missing.",
    ErrorCode.INVALID_STATE_TRANSITION: "That step is not available right now.",
    ErrorCode.UNAUTHENTICATED: "Please sign in to continue.",
    ErrorCode.FORBIDDEN: "You do not have access to do that.",
    ErrorCode.FACE_NOT_DETECTED: "We couldn't detect a face on this ID Card.",
    ErrorCode.MULTIPLE_FACES_DETECTED: (
        "Multiple faces were detected. Please upload a valid ID Card image."
    ),
    ErrorCode.FACE_QUALITY_TOO_LOW: "The face image is unclear. Please upload a clearer ID Card.",
    ErrorCode.FACE_CAPTURE_INVALID: "Please provide a clear photo showing one face.",
    ErrorCode.OCR_UNREADABLE: "We could not read this document. Please upload a clearer image.",
    ErrorCode.DOCUMENT_TYPE_NOT_SUPPORTED: "Please upload a Cambodian ID Card or a passport.",
    ErrorCode.IDENTITY_NOT_VERIFIED: ("The submitted identity information could not be verified."),
    ErrorCode.FACE_NOT_VERIFIED: "The current face could not be verified.",
    ErrorCode.ID_CARD_NOT_VERIFIED: "The ID Card could not be verified.",
    ErrorCode.LIVENESS_FAILED: "The liveness verification was unsuccessful.",
    ErrorCode.ARTIFACT_NOT_FOUND: "That file is no longer available. Please upload it again.",
    ErrorCode.ARTIFACT_EXPIRED: "That file has expired. Please upload it again.",
    ErrorCode.UPSTREAM_AUTH_FAILED: (
        "We could not reach the verification service. Please try again later."
    ),
    ErrorCode.UPSTREAM_TIMEOUT: (
        "The verification service took too long to respond. Please try again."
    ),
    ErrorCode.UPSTREAM_UNAVAILABLE: (
        "The verification service is temporarily unavailable. Please try again later."
    ),
    ErrorCode.UPSTREAM_BAD_RESPONSE: ("We could not complete the verification. Please try again."),
    ErrorCode.CONFIGURATION_ERROR: (
        "The verification service is not configured correctly. Please contact support."
    ),
    ErrorCode.RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
    ErrorCode.INTERNAL_ERROR: "Something went wrong on our side. Please try again.",
}

#: Default HTTP status per code. A *negative verification* is not an HTTP error —
#: it is a successful call whose result is `failed`/`partial` (§28).
DEFAULT_STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_REQUEST: status.HTTP_400_BAD_REQUEST,
    ErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.UNSUPPORTED_IMAGE_TYPE: status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
    ErrorCode.IMAGE_TOO_LARGE: status.HTTP_413_CONTENT_TOO_LARGE,
    ErrorCode.IMAGE_UNREADABLE: status.HTTP_400_BAD_REQUEST,
    ErrorCode.IMAGE_TOO_LOW_RESOLUTION: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.REQUIREMENTS_NOT_MET: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.INVALID_STATE_TRANSITION: status.HTTP_409_CONFLICT,
    ErrorCode.UNAUTHENTICATED: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.FORBIDDEN: status.HTTP_403_FORBIDDEN,
    ErrorCode.FACE_NOT_DETECTED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.MULTIPLE_FACES_DETECTED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.FACE_QUALITY_TOO_LOW: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.FACE_CAPTURE_INVALID: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.OCR_UNREADABLE: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.DOCUMENT_TYPE_NOT_SUPPORTED: status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
    ErrorCode.IDENTITY_NOT_VERIFIED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.FACE_NOT_VERIFIED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.ID_CARD_NOT_VERIFIED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.LIVENESS_FAILED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.ARTIFACT_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.ARTIFACT_EXPIRED: status.HTTP_404_NOT_FOUND,
    ErrorCode.UPSTREAM_AUTH_FAILED: status.HTTP_502_BAD_GATEWAY,
    ErrorCode.UPSTREAM_TIMEOUT: status.HTTP_504_GATEWAY_TIMEOUT,
    ErrorCode.UPSTREAM_UNAVAILABLE: status.HTTP_502_BAD_GATEWAY,
    ErrorCode.UPSTREAM_BAD_RESPONSE: status.HTTP_502_BAD_GATEWAY,
    ErrorCode.CONFIGURATION_ERROR: status.HTTP_500_INTERNAL_SERVER_ERROR,
    ErrorCode.RATE_LIMITED: status.HTTP_429_TOO_MANY_REQUESTS,
    ErrorCode.INTERNAL_ERROR: status.HTTP_500_INTERNAL_SERVER_ERROR,
}


class AppError(Exception):
    """Base class for every error that reaches the client as a safe envelope.

    Args:
        code: A member of `ErrorCode`. Unknown values fall back to
            `INTERNAL_ERROR` rather than leaking.
        message: Overrides the default user message. Must be user-facing text.
        field_errors: Per-field messages for inline form display.
        extra: Additional envelope keys, e.g. the `missing` requirement list.
        http_status: Overrides the default status for this code.
    """

    def __init__(
        self,
        code: ErrorCode = ErrorCode.INTERNAL_ERROR,
        message: str | None = None,
        field_errors: dict[str, str] | None = None,
        extra: dict[str, Any] | None = None,
        http_status: int | None = None,
    ) -> None:
        resolved = code if code in USER_MESSAGES else ErrorCode.INTERNAL_ERROR
        self.code = resolved
        self.message = message or USER_MESSAGES[resolved]
        self.field_errors = field_errors or {}
        self.extra = extra or {}
        self.http_status = http_status or DEFAULT_STATUS[resolved]
        super().__init__(self.message)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}(code={self.code!s}, status={self.http_status})"


class ConfigurationError(AppError):
    """Startup configuration is invalid or incomplete. Never shown to users verbatim."""


class ArtifactNotFoundError(AppError):
    """A referenced artefact handle does not exist or has expired (§29)."""

    def __init__(self, *, expired: bool = False) -> None:
        code = ErrorCode.ARTIFACT_EXPIRED if expired else ErrorCode.ARTIFACT_NOT_FOUND
        super().__init__(code)


class RequirementsNotMetError(AppError):
    """The selected method's requirements are not satisfied (§11).

    The backend derives requirements independently of the frontend; this error is
    the enforcement point.
    """

    def __init__(
        self,
        missing: list[str],
        field_errors: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            ErrorCode.REQUIREMENTS_NOT_MET,
            field_errors=field_errors,
            extra={"missing": missing},
        )
        self.missing = missing


def error_envelope(
    error: AppError,
    *,
    request_id: str,
    include_internal_detail: bool = False,
) -> dict[str, Any]:
    """Build the wire envelope for an error.

    Args:
        error: The error to render.
        request_id: Correlation id. The only diagnostic detail exposed (§28).
        include_internal_detail: Development aid. Adds `detail`; must be `false`
            outside local development so internal text never ships.

    Returns:
        The envelope dict placed at the top level of the error response.
    """
    payload: dict[str, Any] = {
        "error": {
            "code": str(error.code),
            "message": error.message,
            "fieldErrors": error.field_errors,
            "requestId": request_id,
        }
    }
    payload["error"].update(error.extra)
    if include_internal_detail:
        payload["error"]["detail"] = repr(error)
    return payload


def register_exception_handlers(app: FastAPI, *, expose_internal_detail: bool) -> None:
    """Install handlers so every failure leaves as a safe envelope.

    A raw `HTTPException`, an unhandled exception, or a Pydantic validation error
    would otherwise reach the browser with technical text. All three are converted
    here, so no endpoint can leak one by forgetting (§28).
    """

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.http_status == 401 else None
        return JSONResponse(
            status_code=exc.http_status,
            headers=headers,
            content=error_envelope(
                exc,
                request_id=_request_id(request),
                include_internal_detail=expose_internal_detail,
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = {
            ".".join(str(part) for part in err["loc"][1:]) or "request": "This value is not valid."
            for err in exc.errors()
        }
        wrapped = AppError(ErrorCode.INVALID_REQUEST, field_errors=fields)
        return JSONResponse(
            status_code=wrapped.http_status,
            content=error_envelope(
                wrapped,
                request_id=_request_id(request),
                include_internal_detail=expose_internal_detail,
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _http_error_code(exc.status_code)
        wrapped = AppError(code, http_status=exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content=error_envelope(
                wrapped,
                request_id=_request_id(request),
                include_internal_detail=expose_internal_detail,
            ),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # Log the real fault server-side; return nothing technical to the client.
        logger.exception("unhandled error", extra={"request_id": _request_id(request)})
        wrapped = AppError(ErrorCode.INTERNAL_ERROR)
        return JSONResponse(
            status_code=wrapped.http_status,
            # Never expose internal detail for an unhandled fault, even in dev.
            content=error_envelope(wrapped, request_id=_request_id(request)),
        )


def _http_error_code(http_status: int) -> ErrorCode:
    """Map an HTTP status raised by the framework onto a business code.

    A framework 404 becomes `NOT_FOUND` rather than `INVALID_REQUEST`, so the UI
    can tell "nothing here" from "you sent something wrong" (§28).
    """
    if http_status == status.HTTP_404_NOT_FOUND:
        return ErrorCode.NOT_FOUND
    if http_status == status.HTTP_401_UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED
    if http_status == status.HTTP_403_FORBIDDEN:
        return ErrorCode.FORBIDDEN
    if http_status == status.HTTP_405_METHOD_NOT_ALLOWED:
        return ErrorCode.INVALID_REQUEST
    if http_status == status.HTTP_413_CONTENT_TOO_LARGE:
        return ErrorCode.IMAGE_TOO_LARGE
    return ErrorCode.INVALID_REQUEST if http_status < 500 else ErrorCode.INTERNAL_ERROR


def _request_id(request: Request) -> str:
    from app.core.ids import REQUEST_ID_HEADER, new_request_id

    return (
        request.headers.get(REQUEST_ID_HEADER)
        or getattr(request.state, "request_id", None)
        or new_request_id()
    )
