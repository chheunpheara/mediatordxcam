"""SPA serving.

Only exercised when `backend/static` exists, i.e. in the production image where
the frontend stage has already built the SPA. In a source checkout the directory
is absent and these routes are not registered.

The behaviour that matters: client-side routing means a user who bookmarks
`/id-card` or refreshes there requests that path directly. A plain static mount
answers 404 and the app appears broken, so unknown non-API paths return the SPA
shell instead.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture
def spa_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    """An app whose `STATIC_DIR` points at a minimal built-SPA layout."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>Identity Verification</title>")
    (static / "assets" / "index-abc123.js").write_text("console.log('app')")

    monkeypatch.setattr("app.main.STATIC_DIR", static)
    return create_app(Settings(_env_file=None, camdx_mode="mock"))


@pytest.fixture
async def spa_client(spa_app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=spa_app), base_url="http://test") as client:
        yield client


@pytest.mark.parametrize("path", ["/", "/id-card", "/id-card/passport", "/some/deep/link"])
async def test_client_routes_return_the_spa_shell(spa_client: AsyncClient, path: str) -> None:
    response = await spa_client.get(path)

    assert response.status_code == 200
    assert "Identity Verification" in response.text
    # The shell must never be cached, or a deploy would strand users on old code.
    assert response.headers["cache-control"] == "no-store"


async def test_hashed_assets_are_served(spa_client: AsyncClient) -> None:
    response = await spa_client.get("/assets/index-abc123.js")

    assert response.status_code == 200
    assert "console.log" in response.text


async def test_api_paths_are_not_shadowed_by_the_shell(spa_client: AsyncClient) -> None:
    """An unmatched API path must return the JSON envelope, never HTML."""
    response = await spa_client.get("/api/v1/nope")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_health_is_unaffected_by_the_shell(spa_client: AsyncClient) -> None:
    assert (await spa_client.get("/health")).json() == {"status": "ok"}
    assert (await spa_client.get("/api/v1/health")).status_code == 200


def test_no_static_mount_exposes_user_content(spa_app: FastAPI, tmp_path: Path) -> None:
    """Uploaded cards and face crops must never sit under a static path (§29).

    A `StaticFiles` mount turns a directory into public HTTP. That is fine for
    hashed build assets and unacceptable for temp artefact storage, which is why
    artefacts are served through a handle-checked route that enforces expiry on
    every read instead.

    This asserts the negative directly, so adding a convenient-looking mount for
    the temp directory later fails here rather than in production.
    """
    from starlette.routing import Mount

    configured = Path(spa_app.state.settings.temp_storage_dir)
    temp_dirs = {(tmp_path / "tmp").resolve(), configured.resolve()}
    mounts = [
        route
        for route in spa_app.routes
        if isinstance(route, Mount) and "StaticFiles" in type(route.app).__name__
    ]

    for mount in mounts:
        served = Path(str(getattr(mount.app, "directory", ""))).resolve()
        assert served not in temp_dirs, f"{mount.path} serves user content"
        assert "var/tmp" not in served.parts, f"{mount.path} serves the artefact directory"


async def test_artefact_handles_are_not_reachable_as_static_files(spa_client: AsyncClient) -> None:
    """The SPA fallback must not answer for an artefact path.

    Otherwise an unknown handle would return the HTML shell with a `200`, and the
    browser would try to render a web page where it expects image bytes.
    """
    response = await spa_client.get("/api/v1/kyc/artifacts/art_" + "0" * 32)

    assert response.status_code == 404
