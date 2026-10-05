"""Verification against the stored sample records, over HTTP (D13).

The registry mode end to end: seeded rows answer `POST /verify`, one wrong
field is §26's `partial` rather than a refusal, an unknown national ID is
§27's `failed`, and an unreachable database is a 502 with no driver text in it
(§28). SQLite backs these tests — same SQLAlchemy path as PostgreSQL, no
container, no service a developer must remember to start (testing rule 5).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import AppEnvironment, Settings, get_settings
from app.infrastructure.db import (
    SAMPLE_IDENTITIES,
    find_identity_record,
    init_database,
)
from app.main import create_app

VERIFY = "/api/v1/kyc/verify"

#: The mock OCR card's holder, exactly as OCR reads it — plus the date of birth
#: OCR leaves blank, set to the value the registry stores for this record.
CARD_HOLDER = SAMPLE_IDENTITIES[0]

#: The second sample record, spelled out so the test asserts the contract the
#: registry documents, not whatever the seed happens to contain today.
KNOWN_SECOND_RECORD = {
    "nationalId": "123456789",
    "firstNameKhmer": "\u179f\u17d2\u179c\u17b7\u1799",
    "lastNameKhmer": "\u1780\u17d2\u179a\u17b8\u1799",
    "firstNameEnglish": "Sokha",
    "lastNameEnglish": "Cham",
    "gender": "F",
    "dateOfBirth": "1994-02-11",
    "issuedDate": "2021-04-12",
    "expiryDate": "2029-04-12",
}


def submitted(**overrides: str) -> dict[str, str]:
    """A complete nine-field form for the card holder, with per-field edits."""
    values = dict(CARD_HOLDER.extracted_fields)
    values.update(overrides)
    return values


@pytest.fixture
def registry_url(tmp_path: Path) -> str:
    """A private file-backed registry with the sample records seeded."""
    url = f"sqlite:///{tmp_path / 'registry.db'}"
    assert init_database(url) == len(SAMPLE_IDENTITIES)
    return url


@pytest.fixture
async def client(
    registry_url: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> AsyncIterator[AsyncClient]:
    """An app whose DI graph resolves the registry (ASGI runs no lifespan)."""
    monkeypatch.setenv("DATABASE_URL", registry_url)
    get_settings.cache_clear()
    settings = Settings(
        camdx_mode="mock",
        app_env=AppEnvironment.LOCAL,
        log_sensitive_payloads=False,
        temp_storage_dir=tmp_path / "tmp",
        database_url=registry_url,
    )
    app = create_app(settings)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    get_settings.cache_clear()


async def _verify(client: AsyncClient, identity: dict[str, str]):
    return await client.post(
        VERIFY, json={"method": "verify_user_info", "userInformation": identity}
    )


class TestRegistryVerification:
    async def test_a_recorded_identity_verifies_as_success(self, client: AsyncClient) -> None:
        response = await _verify(client, submitted())

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "success"
        assert body["identity"]["matchedCount"] == 9
        assert body["identity"]["incorrectFields"] == []

    async def test_the_other_sample_record_verifies_as_success(self, client: AsyncClient) -> None:
        response = await _verify(client, dict(KNOWN_SECOND_RECORD))

        assert response.status_code == 200, response.text
        assert response.json()["status"] == "success"

    async def test_one_wrong_field_is_partial_and_names_the_field(
        self, client: AsyncClient
    ) -> None:
        """§26: "✓ National ID matched" plus "✕ date of birth differs" — not a flat failure."""
        response = await _verify(client, submitted(dateOfBirth="1999-01-01"))

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "partial"
        assert body["identity"]["incorrectFields"] == ["dateOfBirth"]
        assert body["identity"]["matchedCount"] == 8

    async def test_an_unknown_national_id_fails_every_field(self, client: AsyncClient) -> None:
        response = await _verify(client, submitted(nationalId="999999999"))

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "failed"
        assert body["identity"]["matchedCount"] == 0
        assert len(body["identity"]["incorrectFields"]) == 9

    async def test_accepted_spellings_do_not_mismatch(self, client: AsyncClient) -> None:
        """Case and `male` vs `M` are typing differences, not identity differences."""
        response = await _verify(
            client,
            submitted(firstNameEnglish="sample", lastNameEnglish=" person ", gender="male"),
        )

        assert response.status_code == 200, response.text
        assert response.json()["status"] == "success"


class TestRegistryOperations:
    def test_seeding_is_idempotent(self, tmp_path: Path) -> None:
        """Startup runs this every time; re-running must not duplicate or reset."""
        url = f"sqlite:///{tmp_path / 'seed.db'}"

        assert init_database(url) == len(SAMPLE_IDENTITIES)
        assert init_database(url) == 0
        assert init_database(url) == 0

    def test_an_unknown_id_reads_as_none(self, tmp_path: Path) -> None:
        url = f"sqlite:///{tmp_path / 'lookup.db'}"
        init_database(url)

        assert find_identity_record(url, "000000000000") == SAMPLE_IDENTITIES[0]
        assert find_identity_record(url, "999999999") is None


class TestRegistryFailure:
    async def test_an_unreachable_registry_is_a_safe_502(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """No driver text or DSN reaches the client (§28); the code says retry later."""
        missing_dir_url = f"sqlite:///{tmp_path / 'no-such-dir' / 'registry.db'}"
        monkeypatch.setenv("DATABASE_URL", missing_dir_url)
        get_settings.cache_clear()
        settings = Settings(
            camdx_mode="mock",
            app_env=AppEnvironment.LOCAL,
            log_sensitive_payloads=False,
            temp_storage_dir=tmp_path / "tmp",
            database_url=missing_dir_url,
        )
        app = create_app(settings)
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    VERIFY,
                    json={"method": "verify_user_info", "userInformation": submitted()},
                )
        finally:
            get_settings.cache_clear()

        assert response.status_code == 502
        error = response.json()["error"]
        assert error["code"] == "UPSTREAM_UNAVAILABLE"
        assert "sqlite" not in error["message"].lower()
        assert "no-such-dir" not in error["message"]
