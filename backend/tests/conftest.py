"""Shared test fixtures.

Invariants enforced here rather than repeated per test (§34):

* `CAMDX_MODE` is `mock` — no test may reach the real CamDigiKey service.
* Payload logging is disabled, so a test cannot accidentally emit sensitive data.
* Temp artefact storage points at a per-test directory, so artefacts never leak
  between tests or reach the real `var/tmp`.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.config import AppEnvironment, Settings
from app.main import create_app
from tests.fixtures.images import card_with_face, card_without_face


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Force the safe subset of configuration for the whole test session."""
    monkeypatch.setenv("CAMDX_MODE", "mock")
    monkeypatch.setenv("OCR_PROVIDER", "mock")
    monkeypatch.setenv("LOG_SENSITIVE_PAYLOADS", "false")
    monkeypatch.setenv("APP_ENV", AppEnvironment.LOCAL.value)
    yield


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings with temp storage redirected to a per-test directory."""
    return Settings(
        camdx_mode="mock",
        app_env=AppEnvironment.LOCAL,
        log_sensitive_payloads=False,
        temp_storage_dir=tmp_path / "tmp",
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    """A fresh application instance wired to the test settings."""
    return create_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncClient:
    """In-process HTTP client.

    Uses ASGI transport rather than a live server so tests stay fast and
    deterministic; middleware, routing and exception handlers all still run.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture(scope="session")
def card_bytes() -> bytes:
    """A valid card-shaped image with no face. Used for OCR-only processing."""
    return card_without_face()


@pytest.fixture(scope="session")
def face_card_bytes() -> bytes:
    """A card with one drawn face, for the real-cascade integration test."""
    return card_with_face()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def assert_no_sensitive_data(text: str, *, secrets: list[str]) -> None:
    """Fail if `text` contains any of `secrets` (§29).

    Used by the log-redaction test and the "no upstream text escapes" assertions.
    """
    for secret in secrets:
        assert secret not in text, f"sensitive value leaked into output: {secret!r}"


def json_error(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract the `error` object from an error envelope."""
    return dict(payload["error"])
