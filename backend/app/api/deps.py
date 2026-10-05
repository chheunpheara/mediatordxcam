"""Dependency-injection providers.

`Depends` targets live here so endpoint modules stay thin and so tests can
override a single provider without patching module globals.

Settings are cached for the process lifetime. Each service is built by a provider
that mirrors how it will be constructed in production, so a test override has the
same shape as the real thing.
"""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import Depends, Request

from app.core.config import Settings, get_settings
from app.core.errors import AppError, ErrorCode
from app.domain.auth import ALL_PERMISSIONS, Role, User, UserStatus
from app.integrations.camdx.mock.ocr import MockOcrProvider
from app.integrations.camdx.ocr import OcrProvider
from app.services.artifacts import TempArtifactStore
from app.services.auth import AuthService
from app.services.documents import DocumentProcessor
from app.services.face import FaceService
from app.services.identity_registry import IdentityRegistry
from app.services.integrations import IntegrationService
from app.services.kyc import KycService
from app.services.local_ocr import LocalTesseractOcrProvider
from app.services.records import RecordService

#: The session cookie set at login (D18). `HttpOnly`, so no browser script can
#: read it — the frontend never references this name.
SESSION_COOKIE = "camdx_session"

#: The synthetic principal used while `AUTH_ENABLED=false` (the test suite and
#: nothing else). It holds every permission and admin rights, so enforcement
#: code runs the same shape of path with auth off instead of being skipped —
#: and because tests force the flag off, the suite needs no credentials.
_DEV_USER = User(
    id="auth-disabled",
    email="dev@localhost",
    name="Auth disabled",
    status=UserStatus.ACTIVE,
    roles=(
        Role(
            id="auth-disabled",
            name="All permissions",
            is_admin=True,
            permissions=ALL_PERMISSIONS,
        ),
    ),
)


def settings_provider() -> Settings:
    """Return the process-wide settings."""
    return get_settings()


SettingsDep = Annotated[Settings, Depends(settings_provider)]


def artifact_store_provider(settings: SettingsDep) -> TempArtifactStore:
    """Build the temporary artefact store (§29).

    Constructed per request so settings are honoured, but the underlying
    directory is shared — the store holds no per-request state, so rebuilding it
    is cheap and avoids caching a path that a test may have redirected.
    """
    return TempArtifactStore(
        settings.temp_storage_dir,
        ttl_seconds=settings.temp_artifact_ttl_seconds,
    )


ArtifactStoreDep = Annotated[TempArtifactStore, Depends(artifact_store_provider)]


def ocr_provider_provider(settings: SettingsDep) -> OcrProvider:
    """Select the OCR implementation from `CAMDX_MODE` (§21).

    Only `mock` is wired in Phase 3. A `real` build must supply credentials or
    `validate_startup` has already aborted, so reaching the `NotImplementedError`
    means configuration and code disagree — which is a bug to fix, not a runtime
    condition to paper over with a fallback to mock.
    """
    if settings.ocr_provider == "tesseract":
        return LocalTesseractOcrProvider(
            languages=settings.ocr_languages,
            ollama_base_url=settings.ollama_base_url,
            ollama_model=settings.ollama_model,
        )
    if settings.camdx_mode.value == "mock":
        return MockOcrProvider()
    raise NotImplementedError(
        "real-mode OCR is not implemented yet; see docs/camdx-integration.md "
        "for the open questions that block it."
    )


OcrProviderDep = Annotated[OcrProvider, Depends(ocr_provider_provider)]


def face_service_provider(store: ArtifactStoreDep) -> FaceService:
    """Build the local OpenCV face detector."""
    return FaceService(store)


FaceServiceDep = Annotated[FaceService, Depends(face_service_provider)]


def document_processor_provider(
    ocr: OcrProviderDep,
    face: FaceServiceDep,
    store: ArtifactStoreDep,
) -> DocumentProcessor:
    """Build the ID-card processor from its collaborators."""
    return DocumentProcessor(ocr=ocr, face=face, store=store)


DocumentProcessorDep = Annotated[DocumentProcessor, Depends(document_processor_provider)]


def identity_registry_provider(settings: SettingsDep) -> IdentityRegistry | None:
    """The stored identity records to verify against, or `None` for fixtures (D13).

    `DATABASE_URL` unset — the default, and forced for every test — means the
    fixture provider answers instead. An unset DSN selects a mode; a *set* one
    must work, which startup enforces by connecting before serving
    (`main.lifespan`), so a broken DSN never degrades into fixtures (§21).
    """
    if not settings.database_url:
        return None
    return IdentityRegistry(settings.database_url)


IdentityRegistryDep = Annotated[IdentityRegistry | None, Depends(identity_registry_provider)]


def kyc_service_provider(
    store: ArtifactStoreDep,
    settings: SettingsDep,
    registry: IdentityRegistryDep,
) -> KycService:
    """Build the application-level KYC service (§3).

    Holds no state of its own: it composes the artefact store with the adapter
    registry and re-derives requirements on every call, so a mode change takes
    effect without a stale cached service.
    """
    return KycService(store, camdx_mode=settings.camdx_mode.value, registry=registry)


KycServiceDep = Annotated[KycService, Depends(kyc_service_provider)]


def auth_service_provider(request: Request, settings: SettingsDep) -> AuthService:
    """The account service (D18), built once per application.

    Cached on `app.state` so the store's schema check and seed run once rather
    than per request, and so a test that builds its own app gets its own store.
    Construction touches the database, so callers that run on the event loop
    must wrap it in `asyncio.to_thread` (see `current_user` and `main.lifespan`).
    """
    cached: AuthService | None = getattr(request.app.state, "auth_service", None)
    if cached is None:
        cached = AuthService(settings)
        request.app.state.auth_service = cached
    return cached


AuthServiceDep = Annotated[AuthService, Depends(auth_service_provider)]


async def current_user(request: Request, settings: SettingsDep) -> User:
    """The signed-in user behind this request (D18).

    The whole API is gated: no valid session means `UNAUTHENTICATED`, and a
    disabled account's sessions were revoked when it was disabled. With
    `AUTH_ENABLED=false` this answers the all-permissions development user
    instead — the flag exists for the test suite, never for a deployment.

    The store is only touched when a token is actually presented, so an
    anonymous request fails fast without constructing the account store.
    """
    if not settings.auth_enabled:
        return _DEV_USER
    token = extract_session_token(request)
    if token is None:
        raise AppError(ErrorCode.UNAUTHENTICATED)
    service = await asyncio.to_thread(auth_service_provider, request, settings)
    user = await service.resolve(token)
    if user is None:
        raise AppError(
            ErrorCode.UNAUTHENTICATED,
            message="Your session has expired. Please sign in again.",
        )
    return user


CurrentUserDep = Annotated[User, Depends(current_user)]


async def require_admin(user: CurrentUserDep) -> User:
    """The signed-in user, when they hold admin rights (D18)."""
    if not user.is_admin:
        raise AppError(
            ErrorCode.FORBIDDEN,
            message="You need administrator access to manage accounts.",
        )
    return user


AdminUserDep = Annotated[User, Depends(require_admin)]


def extract_session_token(request: Request) -> str | None:
    """The bearer token from the `Authorization` header or the session cookie.

    Both are accepted: the browser relies on the `HttpOnly` cookie, while curl
    and the backend tests send `Authorization: Bearer …`.
    """
    header = request.headers.get("Authorization")
    if header:
        scheme, _, value = header.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    return request.cookies.get(SESSION_COOKIE)


def integration_service_provider(request: Request, settings: SettingsDep) -> IntegrationService:
    """The posting-settings service (D19), built once per application.

    Cached on `app.state` like the account service; construction creates the
    store's schema, so FastAPI runs this sync provider in a worker thread.
    """
    cached: IntegrationService | None = getattr(request.app.state, "integration_service", None)
    if cached is None:
        cached = IntegrationService(settings)
        request.app.state.integration_service = cached
    return cached


IntegrationServiceDep = Annotated[IntegrationService, Depends(integration_service_provider)]


def record_service_provider(request: Request, settings: SettingsDep) -> RecordService:
    """The uploaded-record service (D23), built once per application.

    Cached on `app.state` like the account service; construction creates the
    store's schema, so FastAPI runs this sync provider in a worker thread.
    """
    cached: RecordService | None = getattr(request.app.state, "record_service", None)
    if cached is None:
        cached = RecordService(settings)
        request.app.state.record_service = cached
    return cached


RecordServiceDep = Annotated[RecordService, Depends(record_service_provider)]


async def require_core_post(user: CurrentUserDep) -> User:
    """The signed-in user, when they hold the full permission set (D19).

    "Post Settings" and "Post to Core Systems" are for Admin and Senior Loan
    Officer — the two seeded roles that carry all six verification permissions.
    Membership is checked as the permission set itself, not by role name, so a
    custom role with the same reach qualifies and a renamed seed role still
    works. Loan Officer (two permissions) is refused.
    """
    if not ALL_PERMISSIONS.issubset(user.permissions):
        raise AppError(
            ErrorCode.FORBIDDEN,
            message="You need every verification permission to post to core systems.",
        )
    return user


CorePostUserDep = Annotated[User, Depends(require_core_post)]
