"""Account administration over HTTP: users, roles, the matrix (D18).

The admin surface end to end, always acting as the seeded administrator:
create/edit/disable accounts, shape roles, replace permission sets — and the
guards that keep the product administrable: no self-deletion, no locking out
the last administrator, no deleting a role someone still holds.
"""

from __future__ import annotations

from httpx import AsyncClient

from app.domain.auth import PASSWORD_POLICY_MESSAGE
from app.domain.enums import OfficialApiName, VerificationMethod
from app.services.auth import DEFAULT_ADMIN_PASSWORD

ADMIN = "admin@gmail.com"
NEW_PASSWORD = "Str0ng!Pass"
ALL_KEYS = {method.value for method in VerificationMethod}


async def _login_admin(client: AsyncClient) -> dict:
    response = await client.post(
        "/api/v1/auth/login", json={"email": ADMIN, "password": DEFAULT_ADMIN_PASSWORD}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _create_user(
    client: AsyncClient, *, email: str, role_ids: list[str], password: str = NEW_PASSWORD
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


async def _roles(client: AsyncClient) -> list[dict]:
    response = await client.get("/api/v1/admin/roles")
    assert response.status_code == 200, response.text
    return response.json()["roles"]


async def _role_id(client: AsyncClient, name: str) -> str:
    for role in await _roles(client):
        if role["name"] == name:
            return role["id"]
    raise AssertionError(f"role {name!r} not found")


class TestCatalogueAndSeeds:
    async def test_the_permission_catalogue_is_exactly_the_six_apis(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        response = await auth_client.get("/api/v1/admin/permissions")

        assert response.status_code == 200
        items = response.json()["permissions"]
        assert {item["key"] for item in items} == ALL_KEYS
        by_key = {item["key"]: item for item in items}
        assert by_key["verify_user_info"]["officialName"] == OfficialApiName.VERIFY_USER_INFO.value
        for item in items:
            assert item["label"]

    async def test_the_three_roles_are_seeded_with_the_documented_scope(
        self, auth_client: AsyncClient
    ) -> None:
        """Requirement 4: Loan Officer, Senior Loan Officer — plus the Admin."""
        await _login_admin(auth_client)

        roles = {role["name"]: role for role in await _roles(auth_client)}

        assert set(roles) == {"Admin", "Loan Officer", "Senior Loan Officer"}
        assert roles["Admin"]["isAdmin"] is True
        assert set(roles["Admin"]["permissions"]) == ALL_KEYS
        assert roles["Loan Officer"]["isAdmin"] is False
        assert set(roles["Loan Officer"]["permissions"]) == {
            "verify_user_info",
            "verify_user_info_face",
        }
        assert set(roles["Senior Loan Officer"]["permissions"]) == ALL_KEYS

    async def test_only_an_administrator_reaches_the_admin_area(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        await _create_user(auth_client, email="loan@example.com", role_ids=[loan_role])
        auth_client.cookies.clear()
        login = await auth_client.post(
            "/api/v1/auth/login",
            json={"email": "loan@example.com", "password": NEW_PASSWORD},
        )
        assert login.status_code == 200, login.text

        for method, path in (
            ("GET", "/api/v1/admin/users"),
            ("GET", "/api/v1/admin/roles"),
            ("POST", "/api/v1/admin/roles"),
        ):
            response = await auth_client.request(
                method, path, json={"name": "Nope"} if method == "POST" else None
            )
            # Signed in, not administrative: a 403, never a 401 or a 404.
            assert response.status_code == 403, response.text
            assert response.json()["error"]["code"] == "FORBIDDEN"


class TestUserAdministration:
    async def test_a_new_account_is_created_listed_edited_and_deleted(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")

        created = await _create_user(auth_client, email="new@example.com", role_ids=[loan_role])
        assert created["status"] == "active"
        assert created["isAdmin"] is False
        assert [role["name"] for role in created["roles"]] == ["Loan Officer"]

        listed = (await auth_client.get("/api/v1/admin/users")).json()["users"]
        assert "new@example.com" in [user["email"] for user in listed]

        renamed = await auth_client.patch(
            f"/api/v1/admin/users/{created['id']}", json={"name": "New Person"}
        )
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "New Person"

        disabled = await auth_client.patch(
            f"/api/v1/admin/users/{created['id']}", json={"status": "disabled"}
        )
        assert disabled.json()["status"] == "disabled"

        deleted = await auth_client.delete(f"/api/v1/admin/users/{created['id']}")
        assert deleted.status_code == 204
        listed = (await auth_client.get("/api/v1/admin/users")).json()["users"]
        assert "new@example.com" not in [user["email"] for user in listed]

    async def test_a_weak_password_is_refused_with_the_policy_sentence(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")

        response = await auth_client.post(
            "/api/v1/admin/users",
            json={
                "email": "weak@example.com",
                "name": "Weak",
                "password": "password",
                "roleIds": [loan_role],
            },
        )

        assert response.status_code == 400
        field_errors = response.json()["error"]["fieldErrors"]
        assert field_errors["password"] == PASSWORD_POLICY_MESSAGE

    async def test_a_duplicate_email_is_refused_regardless_of_case(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        await _create_user(auth_client, email="dup@example.com", role_ids=[loan_role])

        response = await auth_client.post(
            "/api/v1/admin/users",
            json={
                "email": "DUP@example.com",
                "name": "Copy",
                "password": "Str0ng!Pass",
                "roleIds": [],
            },
        )

        assert response.status_code == 400
        assert "email" in response.json()["error"]["fieldErrors"]

    async def test_an_unknown_role_reference_is_a_field_error(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        response = await auth_client.post(
            "/api/v1/admin/users",
            json={
                "email": "ghost@example.com",
                "name": "Ghost",
                "password": "Str0ng!Pass",
                "roleIds": ["nope"],
            },
        )

        assert response.status_code == 400
        assert "roleIds" in response.json()["error"]["fieldErrors"]

    async def test_an_administrator_cannot_delete_their_own_account(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        me = (await auth_client.get("/api/v1/auth/me")).json()

        response = await auth_client.delete(f"/api/v1/admin/users/{me['id']}")

        assert response.status_code == 409
        assert "your own account" in response.json()["error"]["message"]

    async def test_the_last_administrator_cannot_demote_themselves(
        self, auth_client: AsyncClient
    ) -> None:
        """Requirement: an admin set that can shrink, never to zero."""
        await _login_admin(auth_client)
        me = (await auth_client.get("/api/v1/auth/me")).json()
        loan_role = await _role_id(auth_client, "Loan Officer")

        response = await auth_client.patch(
            f"/api/v1/admin/users/{me['id']}", json={"roleIds": [loan_role]}
        )

        assert response.status_code == 403
        assert "own administrator access" in response.json()["error"]["message"]

    async def test_self_demotion_works_once_another_admin_remains(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        admin_role = await _role_id(auth_client, "Admin")
        loan_role = await _role_id(auth_client, "Loan Officer")
        await _create_user(auth_client, email="second@example.com", role_ids=[admin_role])
        me = await auth_client.get("/api/v1/auth/me")

        demoted = await auth_client.patch(
            f"/api/v1/admin/users/{me.json()['id']}", json={"roleIds": [loan_role]}
        )

        assert demoted.status_code == 200, demoted.text
        assert demoted.json()["isAdmin"] is False
        # Still signed in, no longer administrative: permission is derived live
        # from roles, so the very next admin call must bounce.
        blocked = await auth_client.get("/api/v1/admin/users")
        assert blocked.status_code == 403

        # And the account promoted alongside still governs.
        auth_client.cookies.clear()
        relogin = await auth_client.post(
            "/api/v1/auth/login",
            json={"email": "second@example.com", "password": NEW_PASSWORD},
        )
        assert relogin.status_code == 200, relogin.text
        assert (await auth_client.get("/api/v1/admin/users")).status_code == 200


class TestRoleAdministration:
    async def test_a_role_can_be_created_renamed_and_given_permissions(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        created = await auth_client.post(
            "/api/v1/admin/roles",
            json={
                "name": "Auditor",
                "isAdmin": False,
                "permissions": [VerificationMethod.PASSPORT_OCR.value],
            },
        )
        assert created.status_code == 201, created.text
        role = created.json()
        assert role["permissions"] == [VerificationMethod.PASSPORT_OCR.value]

        renamed = await auth_client.patch(
            f"/api/v1/admin/roles/{role['id']}", json={"name": "Senior Auditor"}
        )
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "Senior Auditor"
        # PATCH does not touch permissions.
        assert renamed.json()["permissions"] == [VerificationMethod.PASSPORT_OCR.value]

        deleted = await auth_client.delete(f"/api/v1/admin/roles/{role['id']}")
        assert deleted.status_code == 204

    async def test_the_permission_matrix_replaces_a_role_set(
        self, auth_client: AsyncClient
    ) -> None:
        """PUT = assign/reassign/remove in one operation (requirement 3)."""
        await _login_admin(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")

        first = await auth_client.put(
            f"/api/v1/admin/roles/{loan_role}/permissions",
            json={"permissions": ["verify_user_info", "khmer_id_card_ocr"]},
        )
        assert first.status_code == 200
        assert set(first.json()["permissions"]) == {"verify_user_info", "khmer_id_card_ocr"}

        # Reassign: the old set is gone, not merged.
        second = await auth_client.put(
            f"/api/v1/admin/roles/{loan_role}/permissions",
            json={"permissions": ["passport_ocr"]},
        )
        assert set(second.json()["permissions"]) == {"passport_ocr"}

        # Restore the seeded scope so later tests see the documented roles.
        restored = await auth_client.put(
            f"/api/v1/admin/roles/{loan_role}/permissions",
            json={"permissions": ["verify_user_info", "verify_user_info_face"]},
        )
        assert restored.status_code == 200

    async def test_a_duplicate_role_name_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.post(
            "/api/v1/admin/roles", json={"name": "Loan Officer", "permissions": []}
        )

        assert response.status_code == 400
        assert "name" in response.json()["error"]["fieldErrors"]

    async def test_a_role_still_assigned_to_a_user_cannot_be_deleted(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        loan_role = await _role_id(auth_client, "Loan Officer")
        user = await _create_user(auth_client, email="holder@example.com", role_ids=[loan_role])

        in_use = await auth_client.delete(f"/api/v1/admin/roles/{loan_role}")
        assert in_use.status_code == 409
        assert "still assigned" in in_use.json()["error"]["message"]

        # Move the holder off the role; with no holders left, deletion works.
        moved = await auth_client.patch(f"/api/v1/admin/users/{user['id']}", json={"roleIds": []})
        assert moved.status_code == 200
        assert (await auth_client.delete(f"/api/v1/admin/roles/{loan_role}")).status_code == 204

    async def test_the_admin_role_cannot_be_demoted_below_the_last_administrator(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        admin_role = await _role_id(auth_client, "Admin")

        response = await auth_client.patch(
            f"/api/v1/admin/roles/{admin_role}", json={"isAdmin": False}
        )

        assert response.status_code == 403
        assert "administrator" in response.json()["error"]["message"]
