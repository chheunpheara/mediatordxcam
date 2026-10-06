"""Dual-screen onboarding (Phase 7): WS relay and session mint."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

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


def test_create_session(client: TestClient):
    r = client.post("/api/v1/onboarding/sessions")
    assert r.status_code == 201
    body = r.json()
    assert isinstance(body["sessionId"], str)
    assert body["sessionId"].startswith("sess_")


def test_ws_unknown_session_closed(client: TestClient):
    session_id = client.post("/api/v1/onboarding/sessions").json()["sessionId"]
    with (
        pytest.raises(WebSocketDisconnect) as excinfo,
        client.websocket_connect(f"/ws/onboarding/{session_id}x?role=customer"),
    ):
        pass
    assert excinfo.value.code == 4404


def test_a_customer_joining_announces_itself_to_the_teller(client: TestClient):
    """The monitor tab usually opens last, so its arrival is what lets the
    teller panel re-send the activation command it already fired into an
    empty room."""
    session_id = client.post("/api/v1/onboarding/sessions").json()["sessionId"]
    with (
        client.websocket_connect(f"/ws/onboarding/{session_id}?role=teller") as teller,
        client.websocket_connect(f"/ws/onboarding/{session_id}?role=customer"),
    ):
        assert teller.receive_json() == {"type": "peerJoined"}


def test_ws_relay_customer_to_teller(client: TestClient):
    session_id = client.post("/api/v1/onboarding/sessions").json()["sessionId"]
    with (
        client.websocket_connect(f"/ws/onboarding/{session_id}?role=teller") as teller,
        client.websocket_connect(f"/ws/onboarding/{session_id}?role=customer") as customer,
    ):
        teller.receive_json()  # the arrival notice above
        customer.send_json({"type": "frame", "dataUrl": "/9j/4AAQ"})
        got = teller.receive_json()
        assert got == {"type": "frame", "dataUrl": "/9j/4AAQ"}


def test_ws_relay_teller_to_customer(client: TestClient):
    session_id = client.post("/api/v1/onboarding/sessions").json()["sessionId"]
    with (
        client.websocket_connect(f"/ws/onboarding/{session_id}?role=teller") as teller,
        client.websocket_connect(f"/ws/onboarding/{session_id}?role=customer") as customer,
    ):
        teller.receive_json()  # the arrival notice above
        teller.send_json({"type": "activateLiveness"})
        got = customer.receive_json()
        assert got == {"type": "activateLiveness"}
