"""Sign-in, sessions and the six-method scope, over HTTP (D18).

The whole gate end to end: login starts a session, every KYC route refuses
without one, health stays open, and a Loan Officer may only run the two APIs
their role covers — the refusal appearing both as `403` from `verify` and as a
disabled card with the same sentence on `verification-methods` (§9 + D18).
SQLite backs these tests (testing rule 5); the environment, not only the app
instance, is switched to `AUTH_ENABLED=true` — see `tests/conftest.py`.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.api.v1.endpoints.verification import NO_ACCESS_REASON
from app.core.config import BACKEND_ROOT, Settings
from app.domain.enums import VerificationMethod
from app.infrastructure.auth_store import resolve_auth_database_url
from app.infrastructure.db import SAMPLE_IDENTITIES
from app.services.auth import DEFAULT_ADMIN_PASSWORD, AuthService

ADMIN_EMAIL = "admin@gmail.com"
METHODS = "/api/v1/kyc/verification-methods"
VERIFY = "/api/v1/kyc/verify"
GOOD_PASSWORD = "Str0ng!Pass"


async def _login(client: AsyncClient, email: str = ADMIN_EMAIL, password: str | None = None):
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password or DEFAULT_ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return response


async def _create_user(
    client: AsyncClient, *, email: str, role_ids: list[str], password: str = GOOD_PASSWORD
) -> dict:
    response = await client.post(
        "/api/v1/admin/users",
        json={
            "email": email,
            "name": email.split("@")[0],
            "password": password,
            "roleIds": role_ids,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _role_id(client: AsyncClient, name: str) -> str:
    response = await client.get("/api/v1/admin/roles")
    assert response.status_code == 200, response.text
    for role in response.json()["roles"]:
        if role["name"] == name:
            return role["id"]
    raise AssertionError(f"seeded role {name!r} is missing")


def _method_body(method: VerificationMethod, identity: dict[str, str]) -> dict:
    return {"method": method.value, "userInformation": identity}


class TestLogin:
    async def test_signing_in_returns_a_token_and_sets_an_httponly_cookie(
        self, auth_client: AsyncClient
    ) -> None:
        response = await _login(auth_client)

        body = response.json()
        assert body["token"]
        assert body["user"]["email"] == ADMIN_EMAIL
        assert body["user"]["isAdmin"] is True
        assert body["user"]["status"] == "active"
        assert [role["name"] for role in body["user"]["roles"]] == ["Admin"]

        cookie_header = response.headers.get_list("set-cookie")
        session_cookie = next(c for c in cookie_header if c.startswith("camdx_session="))
        assert "HttpOnly" in session_cookie
        assert "SameSite=lax" in session_cookie

    async def test_wrong_password_and_unknown_account_share_one_reply(
        self, auth_client: AsyncClient
    ) -> None:
        wrong_password = await auth_client.post(
            "/api/v1/auth/login", json={"email": ADMIN_EMAIL, "password": "Nope!Pass1"}
        )
        unknown_account = await auth_client.post(
            "/api/v1/auth/login", json={"email": "nobody@example.com", "password": "Nope!Pass1"}
        )

        assert wrong_password.status_code == unknown_account.status_code == 401
        wrong = wrong_password.json()["error"]
        missing = unknown_account.json()["error"]
        assert wrong["code"] == missing["code"] == "UNAUTHENTICATED"
        # Byte-identical: the form must not reveal which addresses exist (§30).
        assert wrong["message"] == missing["message"]

    async def test_a_disabled_account_is_told_its_account_is_disabled(
        self, auth_client: AsyncClient
    ) -> None:
        await _login(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        user = await _create_user(auth_client, email="off@example.com", role_ids=[loan_role])
        disabled = await auth_client.patch(
            f"/api/v1/admin/users/{user['id']}", json={"status": "disabled"}
        )
        assert disabled.status_code == 200

        response = await auth_client.post(
            "/api/v1/auth/login", json={"email": "off@example.com", "password": GOOD_PASSWORD}
        )

        assert response.status_code == 403
        assert "disabled" in response.json()["error"]["message"].lower()

    async def test_the_email_is_case_insensitive(self, auth_client: AsyncClient) -> None:
        await _login(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        await _create_user(auth_client, email="Ops@Example.com", role_ids=[loan_role])
        auth_client.cookies.clear()

        response = await auth_client.post(
            "/api/v1/auth/login", json={"email": "OPS@example.com", "password": GOOD_PASSWORD}
        )

        assert response.status_code == 200, response.text
        assert response.json()["user"]["email"] == "ops@example.com"


class TestSessionBoundary:
    async def test_health_and_openapi_stay_reachable_without_a_session(
        self, auth_client: AsyncClient
    ) -> None:
        for path in ("/health", "/api/v1/health", "/openapi.json"):
            response = await auth_client.get(path)
            assert response.status_code == 200, path

    @pytest.mark.parametrize(
        ("method", "path", "payload"),
        [
            ("GET", METHODS, None),
            ("POST", VERIFY, {"method": "verify_user_info"}),
            ("GET", "/api/v1/kyc/artifacts/does-not-matter", None),
            ("POST", "/api/v1/kyc/id-card/process", None),
            ("POST", "/api/v1/kyc/face-capture", None),
            ("GET", "/api/v1/admin/users", None),
        ],
    )
    async def test_every_protected_route_answers_401_with_a_challenge(
        self, auth_client: AsyncClient, method: str, path: str, payload: dict | None
    ) -> None:
        response = await auth_client.request(method, path, json=payload)

        assert response.status_code == 401, response.text
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"
        assert response.headers["WWW-Authenticate"] == "Bearer"

    async def test_me_echoes_the_account_behind_the_cookie(self, auth_client: AsyncClient) -> None:
        await _login(auth_client)

        response = await auth_client.get("/api/v1/auth/me")

        assert response.status_code == 200
        assert response.json()["email"] == ADMIN_EMAIL

    async def test_me_accepts_a_bearer_token_without_a_cookie(
        self, auth_client: AsyncClient
    ) -> None:
        token = (await _login(auth_client)).json()["token"]
        auth_client.cookies.clear()

        response = await auth_client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        )

        assert response.status_code == 200
        assert response.json()["email"] == ADMIN_EMAIL

    async def test_an_unrecognized_token_is_refused(self, auth_client: AsyncClient) -> None:
        response = await auth_client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"}
        )

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"

    async def test_logout_revokes_the_session_and_clears_the_cookie(
        self, auth_client: AsyncClient
    ) -> None:
        token = (await _login(auth_client)).json()["token"]

        logout = await auth_client.post("/api/v1/auth/logout")
        assert logout.status_code == 204

        # The cookie is gone from the jar, and the token itself is dead: replay
        # with an explicit header must not resurrect the session.
        replay = await auth_client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        assert replay.status_code == 401


class TestMethodScope:
    async def test_a_loan_officer_sees_only_the_methods_their_role_covers(
        self, auth_client: AsyncClient
    ) -> None:
        await _login(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        await _create_user(auth_client, email="loan@example.com", role_ids=[loan_role])
        auth_client.cookies.clear()
        await _login(auth_client, email="loan@example.com", password=GOOD_PASSWORD)

        methods = {
            item["method"]: item for item in (await auth_client.get(METHODS)).json()["methods"]
        }

        # APIs 1-2 are the Loan Officer's scope: offered normally.
        assert methods[VerificationMethod.VERIFY_USER_INFO.value]["available"] is True
        assert methods[VerificationMethod.VERIFY_USER_INFO.value]["unavailableReason"] is None
        assert methods[VerificationMethod.VERIFY_USER_INFO_FACE.value]["available"] is True

        # APIs 3-6 are out of scope: still listed (§9), disabled, same sentence
        # everywhere — and the reason is about access, not about liveness.
        for method in (
            VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE,
            VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS,
            VerificationMethod.KHMER_ID_CARD_OCR,
            VerificationMethod.PASSPORT_OCR,
        ):
            card = methods[method.value]
            assert card["available"] is False, method
            assert card["unavailableReason"] == NO_ACCESS_REASON

    async def test_a_loan_officer_cannot_call_a_method_outside_their_scope(
        self, auth_client: AsyncClient
    ) -> None:
        await _login(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        await _create_user(auth_client, email="loan@example.com", role_ids=[loan_role])
        auth_client.cookies.clear()
        await _login(auth_client, email="loan@example.com", password=GOOD_PASSWORD)

        identity = dict(SAMPLE_IDENTITIES[0].extracted_fields)
        forbidden = await auth_client.post(
            VERIFY,
            json=_method_body(VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE, identity),
        )
        assert forbidden.status_code == 403, forbidden.text
        assert forbidden.json()["error"]["code"] == "FORBIDDEN"
        assert forbidden.json()["error"]["message"] == NO_ACCESS_REASON

        allowed = await auth_client.post(
            VERIFY, json=_method_body(VerificationMethod.VERIFY_USER_INFO, identity)
        )
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["status"] == "success"

    async def test_the_administrator_may_call_the_first_api(self, auth_client: AsyncClient) -> None:
        """The seeded admin's all-permissions role really reaches verify."""
        await _login(auth_client)

        identity = dict(SAMPLE_IDENTITIES[0].extracted_fields)
        response = await auth_client.post(
            VERIFY, json=_method_body(VerificationMethod.VERIFY_USER_INFO, identity)
        )

        assert response.status_code == 200, response.text


class TestAuthDisabledByDefault:
    async def test_the_suite_default_answers_an_all_permissions_user(
        self, client: AsyncClient
    ) -> None:
        """The conftest `AUTH_ENABLED=false` bypass: `/me` without any login.

        This is the contract every pre-auth test relies on: enforcement code
        runs, and answers the development superuser instead of a 401.
        """
        response = await client.get("/api/v1/auth/me")

        assert response.status_code == 200
        body = response.json()
        assert body["email"] == "dev@localhost"
        assert body["isAdmin"] is True


class TestSeeding:
    async def test_seeding_is_idempotent(self, auth_settings: Settings) -> None:
        AuthService(auth_settings)  # first construction seeds
        second = AuthService(auth_settings)

        roles = await second.list_roles()
        users = await second.list_users()

        assert len(roles) == 3
        assert [user.email for user in users] == [ADMIN_EMAIL]

    async def test_the_seeded_admin_can_sign_in_with_the_documented_password(
        self, auth_settings: Settings
    ) -> None:
        """Requirement 5: the boot-time account actually logs in.

        If the password policy ever stopped accepting `P4ssw0rd!`, seeding
        would raise and this — not the policy unit test — is where the product
        would notice: no administrator, no way in.
        """
        service = AuthService(auth_settings)

        user, token = await service.login(ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)

        assert user.is_admin
        assert token
        assert await service.resolve(token) is not None


def test_auth_settings_fixture_wires_the_dsn(auth_settings: Settings) -> None:
    assert auth_settings.auth_enabled is True
    assert (auth_settings.database_url or "").startswith("sqlite:///")


def test_without_a_dsn_the_account_store_falls_back_under_the_ignored_var_directory() -> None:
    """`resolve_auth_database_url` keeps its output out of git (D18)."""
    resolved = resolve_auth_database_url(None)

    assert resolved.startswith(f"sqlite:///{BACKEND_ROOT / 'var'}")
