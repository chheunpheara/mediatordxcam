"""Liveness links: one usable, expiring display URL per officer (Phase 7).

The contract the customer monitor leans on: a link's token is minted once and
never rewritten, an officer holds at most one usable URL (a second mint
supersedes the first), expiry is enforced by the server rather than the
browser, only the minting officer may take the teller's side of the room, and
an administrator reviewing activity sees metadata — never somebody else's
token.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.config import Settings, get_settings
from app.infrastructure.liveness_link_store import LivenessLinkStore
from app.main import create_app
from app.services.auth import DEFAULT_ADMIN_PASSWORD

LINKS = "/api/v1/onboarding/liveness-links"
ADMIN_EMAIL = "admin@gmail.com"
OFFICER_EMAIL = "dara@example.com"
OFFICER_NAME = "Sok Dara"
OFFICER_PASSWORD = "Str0ng!Pass"


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _error(response: Any) -> dict[str, Any]:
    return dict(response.json()["error"])


def _sign_in(client: TestClient, email: str, password: str) -> tuple[str, dict[str, Any]]:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    body = response.json()
    return body["token"], body["user"]


def _make_officer(client: TestClient, admin_token: str) -> tuple[str, dict[str, Any]]:
    """A Loan Officer account, signed in: the second owner this suite needs."""
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


def _mint(client: TestClient, token: str, **fields: Any) -> dict[str, Any]:
    """POST one link; returns `{link, supersededPrevious}`."""
    payload: dict[str, Any] = {"customer": OFFICER_NAME, "durationSeconds": 3600}
    payload.update(fields)
    response = client.post(LINKS, headers=_bearer(token), json=payload)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def signed_in(auth_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """A signed-in application, speaking the dialect the WS tests need.

    Mirrors `auth_client`: `SettingsDep` resolves from the process-wide cache,
    so the environment — not just `create_app(settings)` — has to say sign-in
    is on and point at this database.
    """
    monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    get_settings.cache_clear()
    with TestClient(create_app(auth_settings)) as client:
        yield client


class TestMinting:
    def test_a_link_carries_its_token_and_an_expiry_the_server_chose(
        self, signed_in: TestClient
    ) -> None:
        token, user = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)

        created = _mint(signed_in, token, customer="Vanna Sophea", durationSeconds=3600)

        assert created["supersededPrevious"] is False
        link = created["link"]
        assert link["token"]
        assert link["status"] == "in_use"
        assert link["supersededAt"] is None
        assert link["owner"] == {"id": user["id"], "name": user["name"]}
        expires_at = datetime.fromisoformat(link["expiresAt"])
        assert expires_at > datetime.now(UTC) + timedelta(minutes=59)

        listed = signed_in.get(LINKS, headers=_bearer(token)).json()["links"]
        assert [item["id"] for item in listed] == [link["id"]]
        assert listed[0]["token"] == link["token"]

    def test_a_second_mint_supersedes_the_first_and_never_rewrites_it(
        self, signed_in: TestClient
    ) -> None:
        token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        first = _mint(signed_in, token)

        second = _mint(signed_in, token, durationSeconds=7200)

        assert second["supersededPrevious"] is True
        links = signed_in.get(LINKS, headers=_bearer(token)).json()["links"]
        assert [item["customer"] for item in links] == [OFFICER_NAME, OFFICER_NAME]
        assert links[0]["id"] == second["link"]["id"]
        assert links[0]["status"] == "in_use"
        assert links[0]["expiresAt"] == second["link"]["expiresAt"]
        assert links[1]["id"] == first["link"]["id"]
        assert links[1]["status"] == "superseded"
        # The old URL keeps naming the same row — it just stopped working.
        assert links[1]["token"] == first["link"]["token"]
        assert links[1]["createdAt"] == first["link"]["createdAt"]
        assert links[1]["supersededAt"] is not None

    @pytest.mark.parametrize(
        ("payload", "field"),
        [
            pytest.param({"customer": OFFICER_NAME}, "expiresAt", id="no-expiry"),
            pytest.param(
                {
                    "customer": OFFICER_NAME,
                    "durationSeconds": 3600,
                    "expiresAt": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
                },
                "expiresAt",
                id="both-rules",
            ),
            pytest.param(
                {
                    "customer": OFFICER_NAME,
                    "expiresAt": (datetime.now(UTC) - timedelta(minutes=5)).isoformat(),
                },
                "expiresAt",
                id="past",
            ),
            pytest.param(
                {"customer": OFFICER_NAME, "expiresAt": datetime.now(UTC).isoformat()},
                "expiresAt",
                id="now",
            ),
            pytest.param(
                {"customer": OFFICER_NAME, "durationSeconds": 0}, "durationSeconds", id="zero"
            ),
            pytest.param(
                {"customer": OFFICER_NAME, "durationSeconds": 60 * 60 * 24 * 31},
                "durationSeconds",
                id="too-long",
            ),
            pytest.param({"customer": "   "}, "customer", id="blank-label"),
            pytest.param({"customer": ""}, "customer", id="empty-label"),
        ],
    )
    def test_an_expiry_the_server_will_not_accept_is_refused_at_the_field(
        self, signed_in: TestClient, payload: dict[str, Any], field: str
    ) -> None:
        token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)

        response = signed_in.post(LINKS, headers=_bearer(token), json=payload)

        assert response.status_code == 400, response.text
        error = _error(response)
        assert error["code"] == "INVALID_REQUEST"
        assert field in error["fieldErrors"]
        # Nothing was minted by the refusal.
        assert signed_in.get(LINKS, headers=_bearer(token)).json()["links"] == []


class TestWhoMaySee:
    def test_an_officer_sees_their_own_links_and_an_administrator_sees_metadata_only(
        self, signed_in: TestClient
    ) -> None:
        admin_token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        officer_token, officer = _make_officer(signed_in, admin_token)
        officer_link = _mint(signed_in, officer_token, customer="Kosal Channa")["link"]
        admin_link = _mint(signed_in, admin_token, customer="Vanna Sophea")["link"]

        mine = signed_in.get(LINKS, headers=_bearer(officer_token)).json()["links"]
        assert [item["id"] for item in mine] == [officer_link["id"]]
        assert mine[0]["token"] == officer_link["token"]

        mine_alone = signed_in.get(LINKS, headers=_bearer(admin_token)).json()["links"]
        assert [item["id"] for item in mine_alone] == [admin_link["id"]]

        refused = signed_in.get(LINKS, params={"scope": "all"}, headers=_bearer(officer_token))
        assert refused.status_code == 403
        assert _error(refused)["code"] == "FORBIDDEN"

        everyone = signed_in.get(
            LINKS, params={"scope": "all"}, headers=_bearer(admin_token)
        ).json()["links"]
        assert {item["id"] for item in everyone} == {officer_link["id"], admin_link["id"]}
        by_id = {item["id"]: item for item in everyone}
        # The administrator gets the row, the officer's name, and no URL.
        assert by_id[officer_link["id"]]["token"] is None
        assert by_id[officer_link["id"]]["owner"] == {
            "id": officer["id"],
            "name": OFFICER_NAME,
        }
        assert by_id[officer_link["id"]]["status"] == "in_use"
        assert by_id[admin_link["id"]]["token"] == admin_link["token"]

    def test_no_endpoint_can_rewrite_a_link_or_extend_the_stay_of_a_url(
        self, signed_in: TestClient
    ) -> None:
        token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        _mint(signed_in, token)

        spec = signed_in.get("/openapi.json").json()

        # Links are only ever listed and minted; the standby screen is only
        # ever read and switched — neither offers an update or a delete.
        assert set(spec["paths"][LINKS]) == {"get", "post"}
        assert set(spec["paths"]["/api/v1/onboarding/liveness-page"]) == {"get", "put"}

    def test_a_minted_url_is_still_listed_by_a_fresh_application(
        self, auth_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The point of the feature: a URL already opened on the customer
        monitor outlives the process that minted it."""
        monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
        monkeypatch.setenv("AUTH_ENABLED", "true")
        get_settings.cache_clear()

        with TestClient(create_app(auth_settings)) as first:
            token, _ = _sign_in(first, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
            link = _mint(first, token)["link"]

        with TestClient(create_app(auth_settings)) as after_restart:
            listed = after_restart.get(LINKS, headers=_bearer(token)).json()["links"]
            assert [item["token"] for item in listed] == [link["token"]]


class TestRooms:
    def test_an_unknown_room_is_accepted_then_closed_with_4404(self, signed_in: TestClient) -> None:
        with (
            signed_in.websocket_connect("/ws/onboarding/sess_missing?role=customer") as customer,
            pytest.raises(WebSocketDisconnect) as excinfo,
        ):
            customer.receive_json()
        assert excinfo.value.code == 4404

    def test_an_expired_link_refuses_the_customer_with_4410(
        self, signed_in: TestClient, auth_settings: Settings
    ) -> None:
        store = LivenessLinkStore(auth_settings.database_url or "")
        expired, _ = store.create(
            owner_id="officer-a", customer=OFFICER_NAME, expires_at=time.time() - 1
        )

        with (
            signed_in.websocket_connect(
                f"/ws/onboarding/{expired.token}?role=customer"
            ) as customer,
            pytest.raises(WebSocketDisconnect) as excinfo,
        ):
            customer.receive_json()

        assert excinfo.value.code == 4410

    def test_a_superseded_link_refuses_the_customer_with_4411(
        self, signed_in: TestClient, auth_settings: Settings
    ) -> None:
        store = LivenessLinkStore(auth_settings.database_url or "")
        old, _ = store.create(
            owner_id="officer-a", customer=OFFICER_NAME, expires_at=time.time() + 3600
        )
        store.create(owner_id="officer-a", customer=OFFICER_NAME, expires_at=time.time() + 3600)

        with (
            signed_in.websocket_connect(f"/ws/onboarding/{old.token}?role=customer") as customer,
            pytest.raises(WebSocketDisconnect) as excinfo,
        ):
            customer.receive_json()

        assert excinfo.value.code == 4411

    def test_only_the_minting_officer_may_take_the_teller_side_of_the_room(
        self, signed_in: TestClient
    ) -> None:
        admin_token, _ = _sign_in(signed_in, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
        officer_token, _ = _make_officer(signed_in, admin_token)
        link = _mint(signed_in, officer_token)["link"]

        with (
            signed_in.websocket_connect(
                f"/ws/onboarding/{link['token']}?role=teller",
                headers=_bearer(officer_token),
            ) as teller,
            signed_in.websocket_connect(
                f"/ws/onboarding/{link['token']}?role=customer"
            ) as customer,
        ):
            assert teller.receive_json() == {"type": "peerJoined"}
            customer.send_json({"type": "frame", "dataUrl": "/9j/4AAQ"})
            assert teller.receive_json() == {"type": "frame", "dataUrl": "/9j/4AAQ"}

        with (
            signed_in.websocket_connect(
                f"/ws/onboarding/{link['token']}?role=teller", headers=_bearer(admin_token)
            ) as teller,
            pytest.raises(WebSocketDisconnect) as excinfo,
        ):
            teller.receive_json()

        assert excinfo.value.code == 4403

    def test_a_url_opened_before_a_restart_still_relay_after_it(
        self, auth_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
        monkeypatch.setenv("AUTH_ENABLED", "true")
        get_settings.cache_clear()

        with TestClient(create_app(auth_settings)) as first:
            token, _ = _sign_in(first, ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
            link = _mint(first, token)["link"]

        with (
            TestClient(create_app(auth_settings)) as after_restart,
            after_restart.websocket_connect(
                f"/ws/onboarding/{link['token']}?role=teller",
                headers=_bearer(token),
            ) as teller,
            after_restart.websocket_connect(
                f"/ws/onboarding/{link['token']}?role=customer"
            ) as customer,
        ):
            assert teller.receive_json() == {"type": "peerJoined"}
            customer.send_json({"type": "activateLiveness"})
            assert teller.receive_json() == {"type": "activateLiveness"}
