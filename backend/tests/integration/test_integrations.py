"""Third-party posting settings over HTTP (D19).

The access rule first — Admin and Senior Loan Officer (the two roles holding
all six permissions) may manage the settings, Loan Officer may not — then the
save contract: passwords are required for new rows, absent from every
response, kept untouched when a save presents them blank, and a refused save
leaves the stored list alone.
"""

from __future__ import annotations

from httpx import AsyncClient

from app.infrastructure.integration_store import IntegrationStore
from app.services.auth import DEFAULT_ADMIN_PASSWORD

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
