"""Third-party posting settings over HTTP (D19, D22).

The access rule first — Admin and Senior Loan Officer (the two roles holding
all six permissions) may manage the settings, Loan Officer may not — then the
save contract: passwords are required for new rows, absent from every
response, kept untouched when a save presents them blank, and a refused save
leaves the stored list alone. `POST /test` (D22) probes one draft row before
that save, with the same password rule and the same safe failure words.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.api.deps import integration_service_provider
from app.core.config import Settings, get_settings
from app.infrastructure.integration_store import IntegrationStore
from app.main import create_app
from app.services.auth import DEFAULT_ADMIN_PASSWORD
from app.services.integrations import IntegrationService

ADMIN = "admin@gmail.com"
PASSWORD = "Str0ng!Pass"

ROW_A = {
    "url": "https://core-a.examplebank.example/post",
    "apiUser": "svc_camdx",
    "apiPassword": "Target-A-1!",
}
ROW_B = {
    "url": "https://core-b.examplebank.example/post",
    "apiUser": "svc_camdx_b",
    "apiPassword": "Target-B-2?",
}


async def _login(client: AsyncClient, email: str, password: str) -> None:
    response = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text


async def _login_admin(client: AsyncClient) -> None:
    await _login(client, ADMIN, DEFAULT_ADMIN_PASSWORD)


async def _role_id(client: AsyncClient, name: str) -> str:
    roles = (await client.get("/api/v1/admin/roles")).json()["roles"]
    for role in roles:
        if role["name"] == name:
            return role["id"]
    raise AssertionError(f"role {name!r} not found")


async def _create_user_with_role(client: AsyncClient, email: str, role_name: str) -> None:
    role_ids = [await _role_id(client, role_name)]
    created = await client.post(
        "/api/v1/admin/users",
        json={
            "email": email,
            "name": email.split("@")[0],
            "password": PASSWORD,
            "roleIds": role_ids,
        },
    )
    assert created.status_code == 201, created.text
    client.cookies.clear()
    await _login(client, email, PASSWORD)


class TestAccess:
    async def test_the_seeded_administrator_manages_settings(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        response = await auth_client.get("/api/v1/integrations/settings")

        assert response.status_code == 200
        assert response.json() == {"settings": []}

    async def test_a_senior_loan_officer_manages_settings(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)
        await _create_user_with_role(auth_client, "senior@example.com", "Senior Loan Officer")

        response = await auth_client.put(
            "/api/v1/integrations/settings", json={"settings": [ROW_A]}
        )

        assert response.status_code == 200, response.text

    async def test_a_loan_officer_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)
        await _create_user_with_role(auth_client, "loan@example.com", "Loan Officer")

        for method in ("GET", "PUT"):
            response = await auth_client.request(
                method,
                "/api/v1/integrations/settings",
                json={"settings": []} if method == "PUT" else None,
            )
            assert response.status_code == 403, response.text
            assert response.json()["error"]["code"] == "FORBIDDEN"
            assert "every verification permission" in response.json()["error"]["message"]

    async def test_a_signed_out_visitor_is_unauthenticated(self, auth_client: AsyncClient) -> None:
        response = await auth_client.get("/api/v1/integrations/settings")

        assert response.status_code == 401


class TestSaveRoundTrip:
    async def test_saving_returns_the_rows_without_their_passwords(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        saved = await auth_client.put(
            "/api/v1/integrations/settings", json={"settings": [ROW_A, ROW_B]}
        )

        assert saved.status_code == 200, saved.text
        settings = saved.json()["settings"]
        assert [item["url"] for item in settings] == [ROW_A["url"], ROW_B["url"]]
        assert [item["apiUser"] for item in settings] == [ROW_A["apiUser"], ROW_B["apiUser"]]
        assert all("apiPassword" not in item for item in settings)
        # Not anywhere in the bytes either — the password never leaves (§29).
        assert ROW_A["apiPassword"] not in saved.text

        fetched = await auth_client.get("/api/v1/integrations/settings")
        assert ROW_A["apiPassword"] not in fetched.text
        assert len(fetched.json()["settings"]) == 2

    async def test_a_blank_password_on_an_existing_row_keeps_the_stored_one(
        self, auth_client: AsyncClient, auth_url: str
    ) -> None:
        await _login_admin(auth_client)
        first = await auth_client.put("/api/v1/integrations/settings", json={"settings": [ROW_A]})
        item = first.json()["settings"][0]

        updated = await auth_client.put(
            "/api/v1/integrations/settings",
            json={
                "settings": [
                    {**ROW_A, "id": item["id"], "apiPassword": "", "url": ROW_A["url"] + "/v2"}
                ]
            },
        )

        assert updated.status_code == 200, updated.text
        assert updated.json()["settings"][0]["url"] == ROW_A["url"] + "/v2"
        stored = IntegrationStore(auth_url).list_settings()
        assert [row.api_password for row in stored] == [ROW_A["apiPassword"]]

    async def test_a_new_row_without_a_password_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.put(
            "/api/v1/integrations/settings",
            json={"settings": [{"url": ROW_A["url"], "apiUser": "svc"}]},
        )

        assert response.status_code == 400
        body = response.json()["error"]
        assert body["fieldErrors"] == {"settings.0.apiPassword": "Enter the API password."}

    async def test_a_url_must_be_a_full_http_address(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.put(
            "/api/v1/integrations/settings",
            json={"settings": [{"url": "core.internal", "apiUser": "svc", "apiPassword": "x"}]},
        )

        assert response.status_code == 400
        assert list(response.json()["error"]["fieldErrors"]) == ["settings.0.url"]

    async def test_a_refused_save_leaves_the_stored_list_untouched(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        await auth_client.put("/api/v1/integrations/settings", json={"settings": [ROW_A]})

        refused = await auth_client.put(
            "/api/v1/integrations/settings",
            json={
                "settings": [
                    {"url": ROW_A["url"], "apiUser": "svc", "apiPassword": "New-Pass-9!"},
                    {"url": "not-a-url", "apiUser": "svc", "apiPassword": "x"},
                ]
            },
        )

        assert refused.status_code == 400
        listed = (await auth_client.get("/api/v1/integrations/settings")).json()["settings"]
        assert [item["url"] for item in listed] == [ROW_A["url"]]


class _Target:
    """The fake core system: records what was sent, answers as told.

    Tests steer it through `respond` (and may raise from it) without any real
    network — the service's injected transport points here.
    """

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.respond: Callable[[httpx.Request], httpx.Response] = _accept

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)


def _accept(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"accepted": True})


@pytest.fixture
async def posting_client(
    auth_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[tuple[AsyncClient, _Target]]:
    """An auth-enforcing client whose outbound posts land on a mock target.

    Mirrors `auth_client`, plus one dependency override: the integration
    service is built with `httpx.MockTransport`, so "the core system" is a
    Python callable in this process — same wiring as production, none of the
    network (testing rule 5).
    """
    monkeypatch.setenv("DATABASE_URL", auth_settings.database_url or "")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    get_settings.cache_clear()
    app = create_app(auth_settings)
    target = _Target()

    def override() -> IntegrationService:
        return IntegrationService(get_settings(), transport=httpx.MockTransport(target.handler))

    app.dependency_overrides[integration_service_provider] = override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac, target
    get_settings.cache_clear()


async def _save_one_setting(client: AsyncClient, row: dict[str, str]) -> None:
    response = await client.put("/api/v1/integrations/settings", json={"settings": [row]})
    assert response.status_code == 200, response.text


class TestPostToCore:
    async def test_a_configured_target_receives_the_payload_with_basic_auth(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)
        await _save_one_setting(client, ROW_A)

        payload = {"method": "OCR", "decision": "approved", "subject": "Jane Doe"}
        response = await client.post("/api/v1/integrations/post", json={"payload": payload})

        assert response.status_code == 200, response.text
        assert response.json() == {"posted": [ROW_A["url"]], "failed": []}
        assert len(target.requests) == 1
        sent = target.requests[0]
        assert str(sent.url) == ROW_A["url"]
        assert json.loads(sent.content) == payload
        assert sent.headers["authorization"].startswith("Basic ")

    async def test_each_target_is_reported_separately_in_safe_words(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)
        saved = await client.put("/api/v1/integrations/settings", json={"settings": [ROW_A, ROW_B]})
        assert saved.status_code == 200, saved.text

        def respond(request: httpx.Request) -> httpx.Response:
            if request.url.host == "core-a.examplebank.example":
                return httpx.Response(200, json={"accepted": True})
            return httpx.Response(500, text="traceback: internal at 10.0.0.7:5432")

        target.respond = respond
        payload = {"decision": "review"}
        response = await client.post("/api/v1/integrations/post", json={"payload": payload})

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["posted"] == [ROW_A["url"]]
        assert body["failed"] == [
            {"url": ROW_B["url"], "reason": "The system did not accept the submission."}
        ]
        assert "traceback" not in response.text
        assert "10.0.0.7" not in response.text
        assert len(target.requests) == 2

    async def test_refused_credentials_read_as_refused_credentials(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)
        await _save_one_setting(client, ROW_A)
        target.respond = lambda _request: httpx.Response(401, json={"error": "bad key"})

        response = await client.post(
            "/api/v1/integrations/post", json={"payload": {"decision": "review"}}
        )

        assert response.status_code == 200
        assert response.json()["failed"] == [
            {"url": ROW_A["url"], "reason": "The system refused the API credentials."}
        ]
        assert "bad key" not in response.text

    async def test_a_timeout_is_reported_without_driver_text(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)
        await _save_one_setting(client, ROW_A)

        def boom(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("connect to 10.1.2.3:443 failed")

        target.respond = boom  # type: ignore[assignment]
        response = await client.post(
            "/api/v1/integrations/post", json={"payload": {"decision": "review"}}
        )

        assert response.status_code == 200
        assert response.json()["failed"] == [
            {"url": ROW_A["url"], "reason": "The system timed out."}
        ]
        assert "10.1.2.3" not in response.text

    async def test_sending_anywhere_without_settings_is_refused(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        response = await client.post(
            "/api/v1/integrations/post", json={"payload": {"decision": "review"}}
        )

        assert response.status_code == 400
        assert response.json()["error"]["message"] == (
            "There are no core systems configured yet. Add one in Post Settings first."
        )
        assert target.requests == []

    async def test_a_loan_officer_cannot_post(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, _target = posting_client
        await _login_admin(client)
        await _create_user_with_role(client, "loan@example.com", "Loan Officer")

        response = await client.post(
            "/api/v1/integrations/post", json={"payload": {"decision": "review"}}
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"


class TestConnection:
    """`POST /integrations/test` (D22): probe one draft row before saving."""

    async def test_a_working_system_answers_ok_and_the_probe_is_impersonal(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        response = await client.post("/api/v1/integrations/test", json=ROW_A)

        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True, "reason": None}
        sent = target.requests[0]
        assert str(sent.url) == ROW_A["url"]
        assert sent.headers["authorization"].startswith("Basic ")
        # A test is not a submission: fixed body, no subject data (§29).
        assert json.loads(sent.content) == {"connectionTest": True}

    async def test_refused_credentials_read_as_refused_credentials(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)
        target.respond = lambda _request: httpx.Response(401, json={"error": "bad key"})

        response = await client.post("/api/v1/integrations/test", json=ROW_A)

        assert response.status_code == 200
        assert response.json() == {
            "ok": False,
            "reason": "The system refused the API credentials.",
        }
        assert "bad key" not in response.text

    async def test_a_timeout_is_reported_without_driver_text(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        def boom(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("connect to 10.1.2.3:443 failed")

        target.respond = boom  # type: ignore[assignment]
        response = await client.post("/api/v1/integrations/test", json=ROW_A)

        assert response.status_code == 200
        assert response.json() == {"ok": False, "reason": "The system timed out."}
        assert "10.1.2.3" not in response.text

    async def test_an_unreachable_or_rejected_system_reads_in_safe_words(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        def unreachable(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("dns failure for core.internal")

        target.respond = unreachable  # type: ignore[assignment]
        refused = await client.post("/api/v1/integrations/test", json=ROW_A)
        assert refused.json() == {"ok": False, "reason": "The system could not be reached."}

        target.respond = lambda _request: httpx.Response(500, text="traceback at 10.0.0.7")
        rejected = await client.post("/api/v1/integrations/test", json=ROW_A)
        assert rejected.json() == {
            "ok": False,
            "reason": "The system did not accept the submission.",
        }
        assert "traceback" not in rejected.text
        assert "10.0.0.7" not in rejected.text

    async def test_a_blank_password_is_tested_with_the_stored_credential(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)
        await _save_one_setting(client, ROW_A)
        stored_id = (await client.get("/api/v1/integrations/settings")).json()["settings"][0]["id"]

        response = await client.post(
            "/api/v1/integrations/test",
            json={**ROW_A, "id": stored_id, "apiPassword": ""},
        )

        assert response.status_code == 200, response.text
        assert response.json()["ok"] is True
        # The Basic header carries the stored password — the rule a save keeps.
        authorization = target.requests[0].headers["authorization"]
        decoded = base64.b64decode(authorization.removeprefix("Basic ")).decode()
        assert decoded == f"{ROW_A['apiUser']}:{ROW_A['apiPassword']}"

    async def test_a_new_row_without_a_password_is_refused_before_any_request(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        response = await client.post(
            "/api/v1/integrations/test",
            json={"url": ROW_A["url"], "apiUser": "svc"},
        )

        assert response.status_code == 400
        assert response.json()["error"]["fieldErrors"] == {"apiPassword": "Enter the API password."}
        assert target.requests == []

    async def test_an_unknown_row_id_cannot_stand_in_for_a_password(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        response = await client.post(
            "/api/v1/integrations/test",
            json={**ROW_A, "id": "its_gone", "apiPassword": ""},
        )

        assert response.status_code == 400
        assert list(response.json()["error"]["fieldErrors"]) == ["apiPassword"]
        assert target.requests == []

    async def test_a_url_must_be_a_full_http_address(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = posting_client
        await _login_admin(client)

        response = await client.post(
            "/api/v1/integrations/test",
            json={"url": "core.internal", "apiUser": "svc", "apiPassword": "x"},
        )

        assert response.status_code == 400
        assert list(response.json()["error"]["fieldErrors"]) == ["url"]
        assert target.requests == []

    async def test_a_loan_officer_cannot_test(
        self, posting_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, _target = posting_client
        await _login_admin(client)
        await _create_user_with_role(client, "loan@example.com", "Loan Officer")

        response = await client.post("/api/v1/integrations/test", json=ROW_A)

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"
