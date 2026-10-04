"""Dependency-injection providers.

`Depends` targets live here so endpoint modules stay thin and so tests can
override a single provider without patching module globals.

Settings are cached for the process lifetime. Each service is built by a provider
that mirrors how it will be constructed in production, so a test override has the
same shape as the real thing.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends

from app.core.config import Settings, get_settings
from app.integrations.camdx.mock.ocr import MockOcrProvider
from app.integrations.camdx.ocr import OcrProvider
from app.services.artifacts import TempArtifactStore
from app.services.documents import DocumentProcessor
from app.services.face import FaceService
from app.services.kyc import KycService
from app.services.local_ocr import LocalTesseractOcrProvider


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
        return LocalTesseractOcrProvider(languages=settings.ocr_languages)
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


def kyc_service_provider(store: ArtifactStoreDep, settings: SettingsDep) -> KycService:
    """Build the application-level KYC service (§3).

    Holds no state of its own: it composes the artefact store with the adapter
    registry and re-derives requirements on every call, so a mode change takes
    effect without a stale cached service.
    """
    return KycService(store, camdx_mode=settings.camdx_mode.value)


KycServiceDep = Annotated[KycService, Depends(kyc_service_provider)]
