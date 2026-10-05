"""Uploaded records over HTTP (D23).

The access rule first — any signed-in account, Loan Officer included, may
upload and verify (unlike `/integrations`, which needs all six permissions),
while a visitor gets 401 — then the record lifecycle: a submission stores the
mapped values as pending, the list searches and pages over them, storing an
outcome flips Status to verified and arms Preview, and the one reusable
column mapping round-trips with its guards (no blank column, no field mapped
twice, no unknown field name).
"""

from __future__ import annotations

from httpx import AsyncClient

from app.services.auth import DEFAULT_ADMIN_PASSWORD

ADMIN = "admin@gmail.com"
PASSWORD = "Str0ng!Pass"


def _values(national_id: str, first_name: str = "Chann", last_name: str = "Sok") -> dict[str, str]:
    return {
        "nationalId": national_id,
        "firstNameKhmer": "ចាន់",
        "lastNameKhmer": "សុខ",
        "firstNameEnglish": first_name,
        "lastNameEnglish": last_name,
        "gender": "Female",
        "dateOfBirth": "2000-01-01",
        "issuedDate": "2020-01-01",
        "expiryDate": "2030-01-01",
    }


def _record(national_id: str, first_name: str = "Chann") -> dict[str, str]:
    return _values(national_id, first_name=first_name)


#: A `POST /verify` success for API #1, exactly as the browser would replay it.
VERIFY_OUTCOME = {
    "status": "success",
    "method": "verify_user_info",
    "identity": {
        "fields": [
            {"field": "nationalId", "status": "matched", "submitted": "123456789"},
            {"field": "dateOfBirth", "status": "mismatch", "submitted": "2000-01-01"},
        ],
        "matchedCount": 1,
        "incorrectFields": ["dateOfBirth"],
    },
    "face": {"required": False},
    "idCard": {"required": False},
    "liveness": {"required": False},
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


async def _create(client: AsyncClient, *records: dict[str, str]) -> dict:
    response = await client.post("/api/v1/records", json={"records": list(records)})
    assert response.status_code == 201, response.text
    return response.json()


class TestAccess:
    async def test_an_administrator_lists_an_empty_list(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.get("/api/v1/records")

        assert response.status_code == 200
        assert response.json() == {"records": [], "total": 0}

    async def test_a_loan_officer_uploads_and_lists(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)
        await _create_user_with_role(auth_client, "loan@example.com", "Loan Officer")

        created = await auth_client.post(
            "/api/v1/records", json={"records": [_record("123456789")]}
        )
        listed = await auth_client.get("/api/v1/records")

        assert created.status_code == 201, created.text
        assert listed.status_code == 200
        assert listed.json()["total"] == 1

    async def test_a_signed_out_visitor_is_unauthenticated(self, auth_client: AsyncClient) -> None:
        listed = await auth_client.get("/api/v1/records")
        created = await auth_client.post("/api/v1/records", json={"records": [_record("1")]})

        assert listed.status_code == 401
        assert created.status_code == 401


class TestCreateAndList:
    async def test_created_records_are_pending_with_normalized_values(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        created = await _create(
            auth_client, {"nationalId": " 123456789 ", "firstNameEnglish": "Chann"}
        )

        assert created["records"][0]["status"] == "pending"
        assert created["records"][0]["verification"] is None
        values = created["records"][0]["values"]
        assert values["nationalId"] == "123456789"
        assert values["firstNameEnglish"] == "Chann"
        # Absent fields are stored as blanks, not omitted or null — the form
        # loads all nine keys either way.
        assert values["expiryDate"] == ""

    async def test_the_list_returns_the_records_newest_first_with_a_total(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        await _create(auth_client, _record("111111111"))
        await _create(auth_client, _record("222222222"))

        listed = await auth_client.get("/api/v1/records")

        body = listed.json()
        assert body["total"] == 2
        assert [row["values"]["nationalId"] for row in body["records"]] == [
            "222222222",
            "111111111",
        ]

    async def test_search_matches_values_but_never_a_field_name(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        await _create(auth_client, _record("111111111", first_name="Chann"))
        await _create(auth_client, _record("222222222", first_name="Dara"))

        by_value = await auth_client.get("/api/v1/records", params={"search": "chann"})
        by_field_name = await auth_client.get("/api/v1/records", params={"search": "nationalId"})

        assert by_value.json()["total"] == 1
        assert by_value.json()["records"][0]["values"]["nationalId"] == "111111111"
        assert by_field_name.json() == {"records": [], "total": 0}

    async def test_like_wildcards_in_the_search_are_data_not_patterns(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        await _create(auth_client, _record("111111111"))

        response = await auth_client.get("/api/v1/records", params={"search": "%"})

        assert response.json() == {"records": [], "total": 0}

    async def test_the_status_filter_splits_pending_from_verified(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        created = await _create(auth_client, _record("111111111"), _record("222222222"))
        first = created["records"][0]["id"]
        verified = await auth_client.post(
            f"/api/v1/records/{first}/verification", json={"verification": VERIFY_OUTCOME}
        )
        assert verified.status_code == 200

        only_pending = await auth_client.get("/api/v1/records", params={"status": "pending"})
        only_verified = await auth_client.get("/api/v1/records", params={"status": "verified"})
        unknown = await auth_client.get("/api/v1/records", params={"status": "done"})

        assert only_pending.json()["total"] == 1
        assert only_pending.json()["records"][0]["values"]["nationalId"] == "222222222"
        assert only_verified.json()["total"] == 1
        assert only_verified.json()["records"][0]["id"] == first
        assert unknown.status_code == 400

    async def test_limit_and_offset_page_over_the_same_total(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        await _create(auth_client, _record("111111111"), _record("222222222"), _record("333333333"))

        first_page = await auth_client.get("/api/v1/records", params={"limit": 2})
        second_page = await auth_client.get("/api/v1/records", params={"limit": 2, "offset": 2})

        assert first_page.json()["total"] == 3
        assert len(first_page.json()["records"]) == 2
        assert len(second_page.json()["records"]) == 1
        page_ids = {row["id"] for row in first_page.json()["records"]}
        assert second_page.json()["records"][0]["id"] not in page_ids

    async def test_an_out_of_range_page_size_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        too_small = await auth_client.get("/api/v1/records", params={"limit": 0})
        too_large = await auth_client.get("/api/v1/records", params={"limit": 51})

        assert too_small.status_code == 400
        assert too_large.status_code == 400

    async def test_an_empty_submission_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.post("/api/v1/records", json={"records": []})

        assert response.status_code == 400

    async def test_a_submission_over_the_batch_cap_is_refused(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        response = await auth_client.post(
            "/api/v1/records", json={"records": [_record(str(i)) for i in range(501)]}
        )

        assert response.status_code == 400

    async def test_a_stray_key_in_a_record_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        row = _record("111111111")
        row["nickname"] = "Channy"
        response = await auth_client.post("/api/v1/records", json={"records": [row]})

        assert response.status_code == 400
        assert list(response.json()["error"]["fieldErrors"]) == ["records.0.nickname"]

    async def test_a_record_with_no_values_at_all_is_refused(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        response = await auth_client.post(
            "/api/v1/records", json={"records": [{"nationalId": "   ", "firstNameEnglish": ""}]}
        )

        assert response.status_code == 400
        assert response.json()["error"]["fieldErrors"] == {
            "records.0.values": "Enter at least one value for this record."
        }


class TestVerification:
    async def test_storing_an_outcome_flips_the_status_and_arms_preview(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)
        created = await _create(auth_client, _record("123456789"))
        record_id = created["records"][0]["id"]

        response = await auth_client.post(
            f"/api/v1/records/{record_id}/verification", json={"verification": VERIFY_OUTCOME}
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "verified"
        assert body["verifiedAt"] is not None
        assert body["verification"]["status"] == "success"
        assert body["verification"]["method"] == "verify_user_info"
        assert body["verification"]["verifiedAt"] == body["verifiedAt"]
        assert body["verification"]["identity"]["matchedCount"] == 1

        listed = await auth_client.get("/api/v1/records")
        assert listed.json()["records"][0]["status"] == "verified"

    async def test_an_unknown_record_is_not_found(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.post(
            "/api/v1/records/does-not-exist/verification",
            json={"verification": VERIFY_OUTCOME},
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
        assert response.json()["error"]["message"] == "That record could not be found."

    async def test_a_stray_key_in_the_outcome_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)
        created = await _create(auth_client, _record("123456789"))
        record_id = created["records"][0]["id"]
        outcome = dict(VERIFY_OUTCOME, score=99)

        response = await auth_client.post(
            f"/api/v1/records/{record_id}/verification", json={"verification": outcome}
        )

        assert response.status_code == 400
        assert list(response.json()["error"]["fieldErrors"]) == ["verification.score"]


class TestMapping:
    async def test_nothing_was_ever_saved(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.get("/api/v1/records/mappings")

        assert response.status_code == 200
        assert response.json() == {"mapping": None}

    async def test_the_mapping_round_trips(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)
        saved = {"ID Number": "nationalId", "DOB": "dateOfBirth"}

        put = await auth_client.put("/api/v1/records/mappings", json={"mapping": saved})
        fetched = await auth_client.get("/api/v1/records/mappings")

        assert put.status_code == 200, put.text
        assert put.json() == {"mapping": saved}
        assert fetched.json() == {"mapping": saved}

    async def test_one_system_field_may_be_mapped_only_once(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.put(
            "/api/v1/records/mappings",
            json={"mapping": {"ID": "nationalId", "Passport No": "nationalId"}},
        )

        assert response.status_code == 400
        assert response.json()["error"]["fieldErrors"] == {
            "mapping.Passport No": "Each system field can be mapped only once."
        }

    async def test_an_unknown_system_field_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.put(
            "/api/v1/records/mappings", json={"mapping": {"Nick": "nickname"}}
        )

        assert response.status_code == 400
        assert list(response.json()["error"]["fieldErrors"]) == ["mapping.Nick"]

    async def test_a_blank_column_name_is_refused(self, auth_client: AsyncClient) -> None:
        await _login_admin(auth_client)

        response = await auth_client.put(
            "/api/v1/records/mappings", json={"mapping": {"  ": "nationalId"}}
        )

        assert response.status_code == 400
        assert response.json()["error"]["fieldErrors"] == {
            "mapping": "A mapped column name cannot be blank."
        }

    async def test_a_stray_key_around_the_mapping_is_refused(
        self, auth_client: AsyncClient
    ) -> None:
        await _login_admin(auth_client)

        response = await auth_client.put(
            "/api/v1/records/mappings", json={"mapping": {"ID": "nationalId"}, "note": "x"}
        )

        assert response.status_code == 400
