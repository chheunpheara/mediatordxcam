"""The audit trail over HTTP (D25).

The two-phase post first: the click commits a `PENDING` entry before any
target is called, the outcome finalises it once, failing targets leave their
status code and body in the audit row while §28's safe words keep governing
the response. Then the reporting API: admin-only, read-only, filterable by
staff, action, status and date range. Verification attempts land as
`IDENTITY_VERIFIED` rows with the national ID masked at rest.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.api.deps import integration_service_provider
from app.core.config import Settings, get_settings
from app.infrastructure.audit_store import AuditLogEntry, AuditStore, new_audit_id
from app.infrastructure.db import init_database
from app.main import create_app
from app.services.auth import DEFAULT_ADMIN_PASSWORD
from app.services.integrations import IntegrationService

ADMIN = "admin@gmail.com"
AUDIT = "/api/v1/admin/audit-logs"
POST = "/api/v1/integrations/post"
VERIFY = "/api/v1/kyc/verify"

TARGET_URL = "https://core-a.examplebank.example/post"
ROW = {"url": TARGET_URL, "apiUser": "svc_camdx", "apiPassword": "Target-A-1!"}

#: A verify-shaped post payload: the decision plus one national ID as
#: `submitted`, exactly what the browser sends after a completed run.
PAYLOAD = {
    "status": "verified",
    "method": "verify_user_info",
    "identity": {
        "fields": [
            {"field": "nationalId", "status": "matched", "submitted": "123456789"},
            {"field": "dateOfBirth", "status": "matched", "submitted": "1994-02-11"},
        ],
        "matchedCount": 9,
        "incorrectFields": [],
    },
    "face": {"required": False, "verified": None},
    "idCard": {"required": False, "verified": None},
    "liveness": {"required": False, "verified": None},
}

#: All nine identity fields, copied from the verification suite (§14).
FULL_IDENTITY = {
    "nationalId": "123456789",
    "firstNameKhmer": "សុខា",
    "lastNameKhmer": "ចម",
    "firstNameEnglish": "Sokha",
    "lastNameEnglish": "Cham",
    "gender": "F",
    "dateOfBirth": "1994-02-11",
    "issuedDate": "2021-04-12",
    "expiryDate": "2029-04-12",
}


class _Target:
    """The fake core system: records what was sent, answers as told."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.respond: Callable[[httpx.Request], httpx.Response] = _accept

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)


def _accept(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"accepted": True})


@pytest.fixture
def audit_url(tmp_path: Path) -> str:
    """A private SQLite DSN with the identity samples seeded.

    Same file plays both parts as `auth_url`: the audit tables are created by
    the store itself, and the seeded registry lets `POST /verify` succeed -
    one private database, no container, never the shared `var/auth.db`.
    """
    url = f"sqlite:///{tmp_path / 'audit.db'}"
    init_database(url)
    return url


@pytest.fixture
async def audit_client(
    settings: Settings, audit_url: str, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[tuple[AsyncClient, _Target]]:
    """A client with sign-in off, its own database and a mock post target.

    Auth stays off (the dev user holds every permission and admin rights), so
    these tests are about the trail itself; the access rules live in
    `TestAccess` against `auth_client`.
    """
    monkeypatch.setenv("DATABASE_URL", audit_url)
    get_settings.cache_clear()
    app = create_app(settings)
    target = _Target()

    def override() -> IntegrationService:
        return IntegrationService(get_settings(), transport=httpx.MockTransport(target.handler))

    app.dependency_overrides[integration_service_provider] = override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac, target
    get_settings.cache_clear()


async def _logs(client: AsyncClient, **params: str) -> dict[str, object]:
    response = await client.get(AUDIT, params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def _save_target(client: AsyncClient, row: dict[str, str] = ROW) -> None:
    response = await client.put("/api/v1/integrations/settings", json={"settings": [row]})
    assert response.status_code == 200, response.text


class TestPostIsAudited:
    async def test_the_click_is_recorded_and_finalised_as_success(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = audit_client
        await _save_target(client)

        response = await client.post(POST, json={"payload": PAYLOAD})

        assert response.status_code == 200, response.text
        assert response.json() == {"posted": [TARGET_URL], "failed": []}
        assert len(target.requests) == 1

        body = await _logs(client)
        assert body["total"] == 1
        [entry] = body["logs"]
        assert entry["actionType"] == "POST_TO_CORE"
        assert entry["status"] == "SUCCESS"
        assert entry["errorResponse"] is None
        assert entry["targetSystemUrl"] == TARGET_URL
        # The authenticated staff member behind the click (SSO session).
        assert entry["staffId"] == "auth-disabled"
        assert entry["staffEmail"] == "dev@localhost"
        assert entry["staffRole"] == "All permissions"
        # The click was recorded before the answer arrived, and finished after.
        assert 0 < entry["createdAt"] <= entry["completedAt"]
        # No invented biometric number (§24); the column ships NULL.
        assert entry["biometricConfidenceScore"] is None
        # The exact transmitted data, national ID masked at rest (§29).
        fields = entry["payloadSnapshot"]["identity"]["fields"]
        assert fields[0] == {"field": "nationalId", "status": "matched", "submitted": "123***89"}
        assert entry["payloadSnapshot"]["status"] == "verified"
        assert "123456789" not in json.dumps(entry["payloadSnapshot"])

    async def test_a_failing_target_leaves_its_error_response_in_the_trail(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = audit_client
        await _save_target(client)
        target.respond = lambda _request: httpx.Response(
            500, text="traceback: internal at 10.0.0.7:5432"
        )

        response = await client.post(POST, json={"payload": PAYLOAD})

        # §28 still governs the operator-facing response...
        assert response.status_code == 200
        assert response.json()["failed"] == [
            {"url": TARGET_URL, "reason": "The system did not accept the submission."}
        ]
        assert "traceback" not in response.text
        assert "10.0.0.7" not in response.text
        # ...while the compliance record keeps the evidence (D25).
        [entry] = (await _logs(client))["logs"]
        assert entry["status"] == "FAILED"
        captured = entry["errorResponse"]
        assert isinstance(captured, str)
        assert "500" in captured
        assert "traceback: internal at 10.0.0.7:5432" in captured

    async def test_a_timeout_is_captured_as_a_failed_entry(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = audit_client
        await _save_target(client)

        def boom(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("connect to 10.1.2.3:443 failed")

        target.respond = boom  # type: ignore[assignment]
        response = await client.post(POST, json={"payload": PAYLOAD})

        assert response.status_code == 200
        assert "10.1.2.3" not in response.text
        [entry] = (await _logs(client))["logs"]
        assert entry["status"] == "FAILED"
        assert "10.1.2.3" in entry["errorResponse"]

    async def test_sending_nowhere_still_records_the_click_as_failed(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, target = audit_client

        response = await client.post(POST, json={"payload": PAYLOAD})

        assert response.status_code == 400
        assert target.requests == []
        body = await _logs(client)
        assert body["total"] == 1
        [entry] = body["logs"]
        assert entry["status"] == "FAILED"
        assert entry["targetSystemUrl"] is None
        assert "no core systems configured" in entry["errorResponse"].lower()


class TestVerificationIsAudited:
    async def test_a_completed_run_is_recorded_with_masked_identity(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, _target = audit_client

        response = await client.post(
            VERIFY, json={"method": "verify_user_info", "userInformation": FULL_IDENTITY}
        )

        assert response.status_code == 200, response.text
        [entry] = (await _logs(client))["logs"]
        assert entry["actionType"] == "IDENTITY_VERIFIED"
        assert entry["status"] == "SUCCESS"
        assert entry["targetSystemUrl"] is None
        assert entry["payloadSnapshot"]["request"]["userInformation"]["nationalId"] == "123***89"
        response_snapshot = entry["payloadSnapshot"]["response"]
        assert response_snapshot["method"] == "verify_user_info"
        assert response_snapshot["status"] in ("verified", "partial", "not_verified")
        assert entry["payloadSnapshot"]["failure"] is None
        assert "123456789" not in json.dumps(entry["payloadSnapshot"])

    async def test_a_refused_run_is_recorded_as_failed(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, _target = audit_client

        response = await client.post(VERIFY, json={"method": "verify_user_info"})

        assert response.status_code >= 400
        [entry] = (await _logs(client))["logs"]
        assert entry["actionType"] == "IDENTITY_VERIFIED"
        assert entry["status"] == "FAILED"
        assert entry["errorResponse"]
        assert entry["payloadSnapshot"]["response"] is None


#: Fixed epochs so the date filters have known material (all UTC).
T_EARLY = datetime(2023, 11, 14, tzinfo=UTC).timestamp()
T_MID = datetime(2024, 10, 27, tzinfo=UTC).timestamp()
T_LATE = datetime(2025, 10, 9, tzinfo=UTC).timestamp()


def _raw_entry(**overrides: object) -> AuditLogEntry:
    base: dict[str, object] = {
        "id": new_audit_id(),
        "created_at": T_MID,
        "staff_id": "staff-1",
        "staff_email": "maker@example.com",
        "staff_role": "Maker",
        "action_type": "POST_TO_CORE",
        "target_system_url": TARGET_URL,
        "payload": {"method": "verify_user_info"},
        "biometric_confidence_score": None,
        "status": "SUCCESS",
        "error_response": None,
        "completed_at": T_MID,
    }
    base.update(overrides)
    return AuditLogEntry(**base)


def _seed(store: AuditStore) -> dict[str, str]:
    """Three rows across staff, actions, statuses and years; keyed by label."""
    rows = {
        "early": _raw_entry(
            created_at=T_EARLY,
            completed_at=T_EARLY,
            staff_id="staff-1",
            action_type="IDENTITY_VERIFIED",
        ),
        "mid": _raw_entry(
            staff_id="staff-2",
            staff_email="checker@example.com",
            staff_role="Checker",
            status="FAILED",
            error_response='[{"url": "' + TARGET_URL + '", "statusCode": 500}]',
        ),
        "late": _raw_entry(created_at=T_LATE, completed_at=T_LATE, staff_id="staff-1"),
    }
    for entry in rows.values():
        store.append(entry)
    return {label: entry.id for label, entry in rows.items()}


class TestReportingApi:
    async def test_filters_narrow_the_trail_and_the_total(
        self, audit_client: tuple[AsyncClient, _Target], audit_url: str
    ) -> None:
        client, _target = audit_client
        ids = _seed(AuditStore(audit_url))

        by_staff = await _logs(client, staffId="staff-1")
        assert by_staff["total"] == 2
        assert [entry["id"] for entry in by_staff["logs"]] == [ids["late"], ids["early"]]

        by_action = await _logs(client, actionType="POST_TO_CORE")
        assert by_action["total"] == 2

        by_status = await _logs(client, status="FAILED")
        assert by_status["total"] == 1
        assert by_status["logs"][0]["id"] == ids["mid"]

        from_2024 = await _logs(client, dateFrom="2024-01-01")
        assert from_2024["total"] == 2

        only_2024 = await _logs(client, dateFrom="2024-01-01", dateTo="2024-12-31")
        assert only_2024["total"] == 1
        assert only_2024["logs"][0]["id"] == ids["mid"]

        combined = await _logs(client, staffId="staff-1", actionType="POST_TO_CORE")
        assert combined["total"] == 1
        assert combined["logs"][0]["id"] == ids["late"]

    async def test_pagination_walks_newest_first(
        self, audit_client: tuple[AsyncClient, _Target], audit_url: str
    ) -> None:
        client, _target = audit_client
        ids = _seed(AuditStore(audit_url))

        first_page = await _logs(client, limit="2", offset="0")
        assert first_page["total"] == 3
        assert [entry["id"] for entry in first_page["logs"]] == [ids["late"], ids["mid"]]

        second_page = await _logs(client, limit="2", offset="2")
        assert second_page["total"] == 3
        assert [entry["id"] for entry in second_page["logs"]] == [ids["early"]]

    async def test_a_bad_filter_is_a_keyed_client_error(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, _target = audit_client

        bad_date = await client.get(AUDIT, params={"dateFrom": "yesterday"})
        assert bad_date.status_code == 400
        assert list(bad_date.json()["error"]["fieldErrors"]) == ["dateFrom"]

        reversed_range = await client.get(
            AUDIT, params={"dateFrom": "2025-01-01", "dateTo": "2024-01-01"}
        )
        assert reversed_range.status_code == 400
        assert "on or before" in reversed_range.json()["error"]["fieldErrors"]["dateFrom"]

        bad_action = await client.get(AUDIT, params={"actionType": "SHRED_IT"})
        assert bad_action.status_code == 400
        assert list(bad_action.json()["error"]["fieldErrors"]) == ["actionType"]

        bad_status = await client.get(AUDIT, params={"status": "MAYBE"})
        assert bad_status.status_code == 400
        assert list(bad_status.json()["error"]["fieldErrors"]) == ["status"]

    async def test_the_trail_has_no_write_route(
        self, audit_client: tuple[AsyncClient, _Target]
    ) -> None:
        client, _target = audit_client

        for method in ("POST", "PUT", "PATCH", "DELETE"):
            response = await client.request(method, AUDIT)
            assert response.status_code == 405, f"{method} must not be allowed"


class TestAccess:
    async def test_an_administrator_reads_the_trail(self, auth_client: AsyncClient) -> None:
        response = await auth_client.post(
            "/api/v1/auth/login", json={"email": ADMIN, "password": DEFAULT_ADMIN_PASSWORD}
        )
        assert response.status_code == 200, response.text

        body = await _logs(auth_client)

        assert body == {"logs": [], "total": 0}

    async def test_a_loan_officer_is_refused(self, auth_client: AsyncClient) -> None:
        await auth_client.post(
            "/api/v1/auth/login", json={"email": ADMIN, "password": DEFAULT_ADMIN_PASSWORD}
        )
        roles = (await auth_client.get("/api/v1/admin/roles")).json()["roles"]
        loan_role = next(role["id"] for role in roles if role["name"] == "Loan Officer")
        created = await auth_client.post(
            "/api/v1/admin/users",
            json={
                "email": "loan@example.com",
                "name": "loan",
                "password": "Str0ng!Pass",
                "roleIds": [loan_role],
            },
        )
        assert created.status_code == 201, created.text
        auth_client.cookies.clear()
        await auth_client.post(
            "/api/v1/auth/login", json={"email": "loan@example.com", "password": "Str0ng!Pass"}
        )

        response = await auth_client.get(AUDIT)

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"

    async def test_a_signed_out_visitor_is_unauthenticated(self, auth_client: AsyncClient) -> None:
        response = await auth_client.get(AUDIT)

        assert response.status_code == 401
