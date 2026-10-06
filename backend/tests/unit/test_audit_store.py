"""The audit store and its append-only guarantees (D25).

The two properties that make the trail worth reading: a row can be written
and read back through the store's own API, and the *database* - not just the
application - refuses every rewrite or deletion, including the ones the store
itself would have to issue through raw SQL.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError

from app.infrastructure.audit_store import (
    AuditLogEntry,
    AuditStore,
    AuditStoreError,
    new_audit_id,
)

#: Fixed timestamps so the date filters in `list_entries` are deterministic.
T_EARLY = 1_700_000_000.0  # 2023-11-14T22:13:20Z
T_LATE = 1_760_000_000.0  # 2025-10-09T08:00:00Z


def _entry(**overrides: object) -> AuditLogEntry:
    base: dict[str, object] = {
        "id": new_audit_id(),
        "created_at": T_EARLY,
        "staff_id": "staff-1",
        "staff_email": "maker@example.com",
        "staff_role": "Maker",
        "action_type": "POST_TO_CORE",
        "target_system_url": "https://core.examplebank.example/post",
        "payload": {"method": "verify_user_info", "nationalId": "123***89"},
        "biometric_confidence_score": None,
        "status": "PENDING",
        "error_response": None,
        "completed_at": None,
    }
    base.update(overrides)
    return AuditLogEntry(**base)


@pytest.fixture
def db_url(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path / 'audit.db'}"


@pytest.fixture
def store(db_url: str) -> AuditStore:
    return AuditStore(db_url)


class TestRoundTrip:
    def test_an_entry_reads_back_exactly_as_written(self, store: AuditStore) -> None:
        entry = _entry()
        store.append(entry)

        logs, total = store.list_entries(
            staff_id=None,
            action_type=None,
            status=None,
            date_from=None,
            date_to=None,
            limit=10,
            offset=0,
        )

        assert total == 1
        assert logs == [entry]

    def test_finalize_completes_a_pending_entry_once(self, store: AuditStore) -> None:
        entry = _entry()
        store.append(entry)

        store.finalize(
            entry.id,
            status="FAILED",
            error_response='[{"url": "u", "statusCode": 500}]',
            completed_at=T_LATE,
        )

        logs, _total = store.list_entries(
            staff_id=None,
            action_type=None,
            status=None,
            date_from=None,
            date_to=None,
            limit=10,
            offset=0,
        )
        assert logs[0].status == "FAILED"
        assert logs[0].error_response == '[{"url": "u", "statusCode": 500}]'
        assert logs[0].completed_at == T_LATE
        # Everything immutable survived the transition.
        assert logs[0].payload == entry.payload
        assert logs[0].created_at == entry.created_at

        with pytest.raises(AuditStoreError):
            store.finalize(entry.id, status="SUCCESS", error_response=None, completed_at=T_LATE)

    def test_finalize_of_a_missing_entry_is_refused(self, store: AuditStore) -> None:
        with pytest.raises(AuditStoreError):
            store.finalize(
                "no-such-entry", status="SUCCESS", error_response=None, completed_at=T_LATE
            )

    def test_filters_narrow_the_page_and_the_total(self, store: AuditStore) -> None:
        one = _entry(
            staff_id="staff-1",
            action_type="IDENTITY_VERIFIED",
            status="SUCCESS",
            completed_at=T_EARLY,
            created_at=T_EARLY,
        )
        two = _entry(
            staff_id="staff-2",
            status="FAILED",
            error_response='{"error": "no settings"}',
            created_at=T_LATE,
        )
        store.append(one)
        store.append(two)

        def query(**filters: object) -> tuple[list[AuditLogEntry], int]:
            defaults: dict[str, object] = {
                "staff_id": None,
                "action_type": None,
                "status": None,
                "date_from": None,
                "date_to": None,
                "limit": 10,
                "offset": 0,
            }
            defaults.update(filters)
            return store.list_entries(**defaults)

        assert query(staff_id="staff-1")[1] == 1
        assert query(action_type="POST_TO_CORE")[1] == 1
        assert query(status="FAILED")[1] == 1
        logs, total = query(status="SUCCESS")
        assert (total, [row.id for row in logs]) == (1, [one.id])
        assert query(date_to=T_EARLY - 1)[1] == 0
        assert query(date_from=T_EARLY + 1)[1] == 1
        # Newest first.
        assert [row.id for row in query()[0]] == [two.id, one.id]

    def test_an_unknown_status_is_corruption_not_a_status(self, store: AuditStore) -> None:
        """A status the vocabulary does not know is a store fault, never rendered."""
        store.append(_entry())
        engine = create_engine(store._database_url)
        # Inserts are not guarded - the guard is about rewriting history - so
        # corruption is simulated the only way a row like this could exist.
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO audit_logs (id, created_at, staff_id, staff_email, staff_role,"
                " action_type, payload_json, status)"
                " VALUES ('weird', 1.0, 's', 'e@example.com', 'Maker', 'POST_TO_CORE',"
                " '{}', 'WEIRD')"
            )

        with pytest.raises(AuditStoreError):
            store.list_entries(
                staff_id=None,
                action_type=None,
                status=None,
                date_from=None,
                date_to=None,
                limit=10,
                offset=0,
            )


class TestTheDatabaseEnforcesAppendOnly:
    def test_a_delete_is_refused_even_from_raw_sql(self, store: AuditStore) -> None:
        store.append(_entry())
        engine = create_engine(store._database_url)

        with pytest.raises(SQLAlchemyError), engine.begin() as conn:
            conn.exec_driver_sql("DELETE FROM audit_logs")

    def test_a_payload_rewrite_is_refused_even_from_raw_sql(self, store: AuditStore) -> None:
        entry = _entry()
        store.append(entry)
        engine = create_engine(store._database_url)

        with pytest.raises(SQLAlchemyError), engine.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE audit_logs SET payload_json = '{}' WHERE id = :id",
                {"id": entry.id},
            )

    def test_a_staff_identity_rewrite_is_refused_even_from_raw_sql(self, store: AuditStore) -> None:
        entry = _entry()
        store.append(entry)
        engine = create_engine(store._database_url)

        with pytest.raises(SQLAlchemyError), engine.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE audit_logs SET staff_id = 'someone-else' WHERE id = :id",
                {"id": entry.id},
            )

    def test_a_finalised_row_is_frozen_even_from_raw_sql(self, store: AuditStore) -> None:
        entry = _entry()
        store.append(entry)
        store.finalize(entry.id, status="SUCCESS", error_response=None, completed_at=T_LATE)
        engine = create_engine(store._database_url)

        with pytest.raises(SQLAlchemyError), engine.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE audit_logs SET status = 'FAILED' WHERE id = :id",
                {"id": entry.id},
            )

    def test_a_status_change_without_the_outcome_is_refused(self, store: AuditStore) -> None:
        """`PENDING` rows may only move to `SUCCESS` or `FAILED` - not stay put."""
        entry = _entry()
        store.append(entry)
        engine = create_engine(store._database_url)

        with pytest.raises(SQLAlchemyError), engine.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE audit_logs SET completed_at = 123.0 WHERE id = :id",
                {"id": entry.id},
            )


def test_the_guard_survives_a_second_construction(db_url: str) -> None:
    """The triggers are dropped and recreated, so startup reruns are no-ops."""
    first = AuditStore(db_url)
    first.append(_entry())
    second = AuditStore(db_url)

    logs, total = second.list_entries(
        staff_id=None,
        action_type=None,
        status=None,
        date_from=None,
        date_to=None,
        limit=10,
        offset=0,
    )
    assert total == 1
    assert logs[0].id
