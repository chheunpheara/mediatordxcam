"""The standby screen: one permanent, global room for the counter monitor (Phase 7).

The contract the counter monitor leans on: its URL is minted exactly once and
never rewritten (no toggle may move the room), any officer may switch the
screen on and off, nobody owns it, it never expires and it supersedes nothing —
while the per-customer link contract is left exactly as it was.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.config import Settings, get_settings
from app.infrastructure.liveness_link_store import LivenessLinkStore
from app.main import create_app
from app.services.auth import DEFAULT_ADMIN_PASSWORD

PAGE = "/api/v1/onboarding/liveness-page"
LINKS = "/api/v1/onboarding/liveness-links"
ADMIN_EMAIL = "admin@gmail.com"
OFFICER_EMAIL = "dara@example.com"
OFFICER_NAME = "Sok Dara"
OFFICER_PASSWORD = "Str0ng!Pass"


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _sign_in(client: TestClient, email: str, password: str) -> tuple[str, dict[str, object]]:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    body = response.json()
    return body["token"], body["user"]


def _make_officer(client: TestClient, admin_token: str) -> tuple[str, dict[str, object]]:
    """A Loan Officer account, signed in — the second voice this suite needs."""
    roles = client.get("/api/v1/admin/roles", headers=_bearer(admin_token)).json()["roles"]
    officer_role = next(role for role in roles if role["name"] == "Loan Officer")
    created = client.post(
        "/api/v1/admin/users",
        headers=_bearer(admin_token),
        json={
            "email": OFFICER_EMAIL,
            "name": OFFICER_NAME,
            "password": OFFICER_PASSWORD,
            "roleIds": [officer_role["id"]],
        },
    )
    assert created.status_code == 201, created.text
    return _sign_in(client, OFFICER_EMAIL, OFFICER_PASSWORD)


def _mint(client: TestClient, token: str) -> dict[str, object]:
    response = client.post(
        LINKS,
        headers=_bearer(token),
        json={"customer": OFFICER_NAME, "durationSeconds": 3600},
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def signed_in(auth_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """A signed-in application, speaking the dialect the WS tests need."""
    monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    get_settings.cache_clear()
    with TestClient(create_app(auth_settings)) as client:
        yield client


class TestStandbyUrl:
    def test_the_url_is_minted_once_and_no_toggle_may_move_it(self, signed_in: TestClient) -> None:
        token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)

        first = signed_in.get(PAGE, headers=_bearer(token))
        assert first.status_code == 200, first.text
        assert first.json()["enabled"] is False
        session_id = first.json()["sessionId"]
        assert session_id

        turned_on = signed_in.put(PAGE, headers=_bearer(token), json={"enabled": True})
        assert turned_on.status_code == 200, turned_on.text
        assert turned_on.json() == {"enabled": True, "sessionId": session_id}

        turned_off = signed_in.put(PAGE, headers=_bearer(token), json={"enabled": False})
        assert turned_off.json() == {"enabled": False, "sessionId": session_id}

    def test_a_second_application_still_serves_the_same_url_and_switch(
        self, auth_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The monitor's URL and the officer's switch outlive the process."""
        monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
        monkeypatch.setenv("AUTH_ENABLED", "true")
        get_settings.cache_clear()

        with TestClient(create_app(auth_settings)) as first:
            token, _ = _sign_in(first, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
            session_id = first.get(PAGE, headers=_bearer(token)).json()["sessionId"]
            first.put(PAGE, headers=_bearer(token), json={"enabled": True})

        with TestClient(create_app(auth_settings)) as after_restart:
            served = after_restart.get(PAGE, headers=_bearer(token)).json()
            assert served == {"enabled": True, "sessionId": session_id}

    def test_any_officer_may_switch_the_screen_but_a_stranger_may_not_read_it(
        self, signed_in: TestClient
    ) -> None:
        admin_token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        officer_token, _ = _make_officer(signed_in, admin_token)

        switched = signed_in.put(PAGE, headers=_bearer(officer_token), json={"enabled": True})
        assert switched.status_code == 200, switched.text
        assert switched.json()["enabled"] is True
        # It is one room: the administrator reads the very same switch.
        assert signed_in.get(PAGE, headers=_bearer(admin_token)).json()["enabled"] is True

        # Sign-in also set a cookie, so drop it: these two have no credentials.
        signed_in.cookies.clear()
        anonymous_get = signed_in.get(PAGE)
        anonymous_put = signed_in.put(PAGE, json={"enabled": False})
        assert anonymous_get.status_code == 401
        assert anonymous_put.status_code == 401

    def test_minting_a_link_leaves_the_standby_room_alone(
        self, signed_in: TestClient, auth_settings: Settings
    ) -> None:
        token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        signed_in.put(PAGE, headers=_bearer(token), json={"enabled": True})
        standby = signed_in.get(PAGE, headers=_bearer(token)).json()
        assert standby["enabled"] is True

        # Building the link table must not retire the standby table — that was
        # the whole of the old design's migration, and both live together now.
        LivenessLinkStore(auth_settings.database_url or "")
        minted = _mint(signed_in, token)

        assert signed_in.get(PAGE, headers=_bearer(token)).json() == standby
        links = signed_in.get(LINKS, headers=_bearer(token)).json()["links"]
        assert [link["token"] for link in links] == [minted["link"]["token"]]
        assert standby["sessionId"] not in [link["token"] for link in links]


class TestStandbyRooms:
    def test_any_teller_may_take_the_standby_room_and_relay_frames(
        self, signed_in: TestClient
    ) -> None:
        admin_token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        officer_token, _ = _make_officer(signed_in, admin_token)
        session_id = signed_in.get(PAGE, headers=_bearer(admin_token)).json()["sessionId"]
        signed_in.put(PAGE, headers=_bearer(admin_token), json={"enabled": True})
        # The officer owns no standby room; they merely opened it.
        _mint(signed_in, officer_token)

        with (
            signed_in.websocket_connect(
                f"/ws/onboarding/{session_id}?role=teller", headers=_bearer(officer_token)
            ) as teller,
            signed_in.websocket_connect(f"/ws/onboarding/{session_id}?role=customer") as customer,
        ):
            assert teller.receive_json() == {"type": "peerJoined"}
            customer.send_json({"type": "frame", "dataUrl": "/9j/4AAQ"})
            assert teller.receive_json() == {"type": "frame", "dataUrl": "/9j/4AAQ"}

    def test_while_the_screen_is_off_the_room_answers_4412_and_an_unknown_one_4404(
        self, signed_in: TestClient
    ) -> None:
        token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        session_id = signed_in.get(PAGE, headers=_bearer(token)).json()["sessionId"]

        with (
            signed_in.websocket_connect(f"/ws/onboarding/{session_id}?role=customer") as customer,
            pytest.raises(WebSocketDisconnect) as off,
        ):
            customer.receive_json()
        assert off.value.code == 4412

        with (
            signed_in.websocket_connect("/ws/onboarding/sess_missing?role=customer") as stranger,
            pytest.raises(WebSocketDisconnect) as unknown,
        ):
            stranger.receive_json()
        assert unknown.value.code == 4404

        signed_in.put(PAGE, headers=_bearer(token), json={"enabled": True})
        with (
            signed_in.websocket_connect(
                f"/ws/onboarding/{session_id}?role=teller", headers=_bearer(token)
            ) as teller,
            signed_in.websocket_connect(f"/ws/onboarding/{session_id}?role=customer") as customer,
        ):
            assert teller.receive_json() == {"type": "peerJoined"}
            customer.send_json({"type": "activateLiveness"})
            assert teller.receive_json() == {"type": "activateLiveness"}

    def test_an_open_standby_screen_does_not_relax_a_unique_link(
        self, signed_in: TestClient
    ) -> None:
        admin_token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        officer_token, _ = _make_officer(signed_in, admin_token)
        signed_in.put(PAGE, headers=_bearer(admin_token), json={"enabled": True})
        link = _mint(signed_in, officer_token)["link"]

        with (
            signed_in.websocket_connect(
                f"/ws/onboarding/{link['token']}?role=teller", headers=_bearer(admin_token)
            ) as teller,
            pytest.raises(WebSocketDisconnect) as excinfo,
        ):
            teller.receive_json()

        assert excinfo.value.code == 4403
