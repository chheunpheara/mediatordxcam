"""Shared test fixtures.

Invarianten enforced here rather than repeated per test (§34):

* `CAMDX_MODE` is `mock` — no test may reach the real CamDigiKey service.
* `DATABASE_URL` is empty — no test may reach a database unless it builds its
  own registry fixture (D13). A repository `.env` can point at a local
  PostgreSQL, and tests must not depend on it being up.
* Payload logging is disabled, so a test cannot accidentally emit sensitive data.
* Temp artefact storage points at a per-test directory, so artefacts never leak
  between tests or reach the real `var/tmp`.

`get_settings` is a process-wide cache, so it is cleared around every test:
whatever the next test builds must read the environment *that* test set, not
one left behind by its predecessor.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.config import AppEnvironment, Settings, get_settings
from app.infrastructure.db import init_database
from app.main import create_app
from tests.fixtures.images import card_with_face, card_without_face


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Force the safe subset of configuration for the whole test session."""
    monkeypatch.setenv("CAMDX_MODE", "mock")
    monkeypatch.setenv("OCR_PROVIDER", "mock")
    monkeypatch.setenv("LOG_SENSITIVE_PAYLOADS", "false")
    monkeypatch.setenv("APP_ENV", AppEnvironment.LOCAL.value)
    # Sign-in is off for every test (D18): the suite exercises behaviour, not
    # credentials, and a forced `false` here is what lets all pre-auth tests
    # pass unchanged. Auth tests opt back in with `Settings(auth_enabled=True)`.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    # Empty, not unset: `.env` may set a DSN, and only an explicit empty value
    # overrides the file (the field validator then maps it back to "no registry").
    monkeypatch.setenv("DATABASE_URL", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


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


@pytest.fixture
def auth_url(tmp_path: Path) -> str:
    """A private SQLite DSN with the identity samples seeded (D18 tests).

    One file plays both parts: the auth tables are created by the account store
    itself, and the identity rows this seeds let `POST /verify` succeed for the
    permission tests — auth-on, registry-on, no container (testing rule 5).
    """
    url = f"sqlite:///{tmp_path / 'auth.db'}"
    init_database(url)
    return url


@pytest.fixture
def auth_settings(auth_url: str, tmp_path: Path) -> Settings:
    """Settings with sign-in enabled against `auth_url`."""
    return Settings(
        camdx_mode="mock",
        app_env=AppEnvironment.LOCAL,
        log_sensitive_payloads=False,
        temp_storage_dir=tmp_path / "tmp",
        database_url=auth_url,
        auth_enabled=True,
    )


@pytest.fixture
async def auth_client(
    auth_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[AsyncClient]:
    """An in-process client whose app enforces sign-in (D18).

    `SettingsDep` resolves from the process-wide cache, so the environment —
    not just `create_app(settings)` — must say `AUTH_ENABLED=true`, exactly as
    `test_identity_registry.py` does for its DSN. The cookie jar is shared
    across requests in one test: login once, then act as that user.
    """
    monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    get_settings.cache_clear()
    app = create_app(auth_settings)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    get_settings.cache_clear()


def assert_no_sensitive_data(text: str, *, secrets: list[str]) -> None:
    """Fail if `text` contains any of `secrets` (§29).

    Used by the log-redaction test and the "no upstream text escapes" assertions.
    """
    for secret in secrets:
        assert secret not in text, f"sensitive value leaked into output: {secret!r}"


def json_error(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract the `error` object from an error envelope."""
    return dict(payload["error"])
