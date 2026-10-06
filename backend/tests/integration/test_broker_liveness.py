"""Liveness video upload: content-type guard and artefact storage (Phase 7)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import AppEnvironment, Settings, get_settings
from app.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    get_settings.cache_clear()
    settings = Settings(
        camdx_mode="mock",
        app_env=AppEnvironment.LOCAL,
        log_sensitive_payloads=False,
        temp_storage_dir=tmp_path / "tmp",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()


def test_accepts_webm(client: TestClient):
    blob = b"\x1a\x45\xdf\xa3" + b"\x00" * 64  # minimal EBML-shaped start
    r = client.post(
        "/api/broker/verify-liveness",
        files={"liveness_video": ("liveness.webm", blob, "video/webm")},
    )
    assert r.status_code == 201
    assert r.json()["livenessRef"]


def test_rejects_non_video(client: TestClient):
    r = client.post(
        "/api/broker/verify-liveness",
        files={"liveness_video": ("hi.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "UNSUPPORTED_VIDEO_TYPE"


def test_rejects_empty_file(client: TestClient):
    r = client.post(
        "/api/broker/verify-liveness",
        files={"liveness_video": ("liveness.webm", b"", "video/webm")},
    )
    assert r.status_code == 400


def test_a_format_nothing_records_is_refused(client: TestClient):
    """Only what a browser's MediaRecorder emits here is accepted — webm and mp4."""
    r = client.post(
        "/api/broker/verify-liveness",
        files={"liveness_video": ("clip.mov", b"\x00" * 64, "video/quicktime")},
    )
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "UNSUPPORTED_VIDEO_TYPE"


def test_the_stored_clip_is_fetchable_by_its_handle(client: TestClient):
    """The teller's preview depends on this round trip: store, then serve back."""
    blob = b"\x1a\x45\xdf\xa3" + b"\x00" * 64
    stored = client.post(
        "/api/broker/verify-liveness",
        files={"liveness_video": ("liveness.webm", blob, "video/webm")},
    )
    assert stored.status_code == 201

    fetched = client.get(f"/api/v1/kyc/artifacts/{stored.json()['livenessRef']}")

    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "video/webm"
    assert fetched.content == blob
