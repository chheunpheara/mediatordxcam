"""The audit trail store (D25): append-only evidence of manual actions.

One table, `audit_logs`, holding who did what, when, to which target system,
with what data and with what outcome. Same trade-offs as the other stores -
schema at first use rather than Alembic, blocking calls in a worker thread, no
DSN or SQL escaping this module (§29) - plus one difference: the database
itself enforces immutability, because an audit trail only means something if
the application cannot rewrite it.

The equivalent SQL (the ORM model below plus the triggers, which SQLAlchemy
cannot express and this module runs as raw DDL after `create_all`):

```sql
CREATE TABLE audit_logs (
    id                       VARCHAR(36)  PRIMARY KEY,
    created_at               FLOAT        NOT NULL,  -- UTC epoch seconds
    staff_id                 VARCHAR(36)  NOT NULL,
    staff_email              VARCHAR(255) NOT NULL,
    staff_role               VARCHAR(255) NOT NULL,
    action_type              VARCHAR(64)  NOT NULL,
    target_system_url        VARCHAR(2048),
    payload_json             TEXT         NOT NULL,  -- masked snapshot
    biometric_confidence_score FLOAT,
    status                   VARCHAR(16)  NOT NULL,  -- PENDING | SUCCESS | FAILED
    error_response           TEXT,
    completed_at             FLOAT
);
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
    ... RAISE(ABORT, 'append-only');            -- SQLite
    ... RAISE EXCEPTION 'append-only';          -- PostgreSQL
CREATE TRIGGER audit_logs_guard BEFORE UPDATE ON audit_logs
    ... only PENDING -> SUCCESS/FAILED, and only status,
        error_response and completed_at may change (see _ensure_append_only).
```

Append-only, precisely: `DELETE` is always refused, and an `UPDATE` is only
accepted for the one transition the feature requires - a row born `PENDING`
(the millisecond the staff member clicked) moving once to `SUCCESS` or
`FAILED` when the target system answered. Every immutable column is compared
against its old value, so a rewrite of who, when, what or the payload itself
is refused by the database even from raw SQL. There is no `update` or
`delete` method on this store beyond that single guarded `finalize`, and no
endpoint anywhere mutates a row (D25).

Timestamps are epoch seconds (`time.time()`, UTC), the same portability rule
as the account store: SQLite and PostgreSQL compare them identically
(`auth_store` explains why). Storage shares the account store's database
(`DATABASE_URL`, else `backend/var/auth.db`): one deployment, one backup.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from sqlalchemy import Float, String, Text, create_engine, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.infrastructure.auth_store import resolve_auth_database_url

logger = logging.getLogger("camdx.audit")

#: The manual actions the gateway records (D25). `POST_TO_CORE` and
#: `IDENTITY_VERIFIED` are wired today; `CAMDX_FETCH` and `MANUAL_APPROVED`
#: are part of the vocabulary so the reporting API can filter them once their
#: triggers land. Success and failure live in `status`, not here: a row says
#: which action it is, then how it ended.
AuditActionType = Literal["CAMDX_FETCH", "IDENTITY_VERIFIED", "MANUAL_APPROVED", "POST_TO_CORE"]

AUDIT_ACTIONS: tuple[AuditActionType, ...] = (
    "CAMDX_FETCH",
    "IDENTITY_VERIFIED",
    "MANUAL_APPROVED",
    "POST_TO_CORE",
)

#: Row lifecycle: written at the moment of the action, finalised exactly once.
AuditStatus = Literal["PENDING", "SUCCESS", "FAILED"]

AUDIT_STATUSES: tuple[AuditStatus, ...] = ("PENDING", "SUCCESS", "FAILED")

#: Guard messages. Deliberately explicit about the rule being enforced; they
#: surface in tests and in server logs, never in an API response (§28).
_MSG_DELETE = "audit_logs is append-only: rows cannot be deleted"
_MSG_UPDATE = "audit_logs rows may only move from PENDING to SUCCESS or FAILED"


class AuditStoreError(RuntimeError):
    """The audit store could not be written or queried (§28)."""


@dataclass(frozen=True)
class AuditLogEntry:
    """One immutable record; `payload` is the already-masked JSON snapshot."""

    id: str
    created_at: float
    staff_id: str
    staff_email: str
    staff_role: str
    action_type: AuditActionType
    target_system_url: str | None
    payload: dict[str, object]
    biometric_confidence_score: float | None
    status: AuditStatus
    error_response: str | None
    completed_at: float | None


class _Base(DeclarativeBase):
    pass


class AuditLogRow(_Base):
    """One audit row; column names mirror `AuditLogEntry`."""

    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    #: UTC epoch seconds of the action itself (the required `timestamp`).
    created_at: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    staff_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    staff_email: Mapped[str] = mapped_column(String(255), nullable=False)
    #: The SSO role names held at the moment of the action, comma-separated.
    staff_role: Mapped[str] = mapped_column(String(255), nullable=False)
    action_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    #: Where the post went; comma-separated when several systems are configured.
    target_system_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    #: JSON object of the masked snapshot (D25 service layer masks before this).
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    #: Reserved for a real liveness/face-match percentage; `NULL` until the
    #: build actually has one (§24 forbids inventing a score).
    biometric_confidence_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    #: The target system's error response (or the refusal reason), text so a
    #: non-JSON body still fits.
    error_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[float | None] = mapped_column(Float, nullable=True)


def resolve_audit_database_url(database_url: str | None) -> str:
    """Same decision as the account store: `DATABASE_URL`, else `var/auth.db`.

    One database per deployment, so audit rows are backed up with the
    accounts, records and posting settings they describe.
    """
    return resolve_auth_database_url(database_url)


class AuditStore:
    """Blocking, append-only reads and writes for audit rows. One per app."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        try:
            engine = _engine_for(database_url)
            _Base.metadata.create_all(engine)
            _ensure_append_only(engine)
        except SQLAlchemyError as exc:
            raise AuditStoreError("audit store is unreachable") from exc

    def append(self, entry: AuditLogEntry) -> None:
        """Insert one row in its own committed transaction.

        Committed immediately and on its own: the entry records the click, so
        it must be durable before the outbound call happens - a crash mid-post
        must not be able to erase it.
        """
        try:
            with _session_scope(self._database_url) as session:
                session.add(
                    AuditLogRow(
                        id=entry.id,
                        created_at=entry.created_at,
                        staff_id=entry.staff_id,
                        staff_email=entry.staff_email,
                        staff_role=entry.staff_role,
                        action_type=entry.action_type,
                        target_system_url=entry.target_system_url,
                        payload_json=json.dumps(entry.payload, sort_keys=True),
                        biometric_confidence_score=entry.biometric_confidence_score,
                        status=entry.status,
                        error_response=entry.error_response,
                        completed_at=entry.completed_at,
                    )
                )
        except SQLAlchemyError as exc:
            raise AuditStoreError("audit log entry could not be written") from exc

    def finalize(
        self,
        entry_id: str,
        *,
        status: Literal["SUCCESS", "FAILED"],
        error_response: str | None,
        completed_at: float,
    ) -> None:
        """Record the outcome of a `PENDING` row - the only update allowed.

        The database trigger decides: `PENDING` to `SUCCESS`/`FAILED` with the
        three outcome columns changing and every immutable column untouched,
        exactly once. Anything else (rewriting the payload, finalising a
        finalised row, touching a missing row) raises here.
        """
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(AuditLogRow, entry_id)
                if row is None:
                    raise AuditStoreError("audit log entry does not exist")
                row.status = status
                row.error_response = error_response
                row.completed_at = completed_at
                session.flush()
        except AuditStoreError:
            raise
        except SQLAlchemyError as exc:
            raise AuditStoreError("audit log finalisation was refused") from exc

    def list_entries(
        self,
        *,
        staff_id: str | None,
        action_type: str | None,
        status: str | None,
        date_from: float | None,
        date_to: float | None,
        limit: int,
        offset: int,
    ) -> tuple[list[AuditLogEntry], int]:
        """A filtered page, newest first, plus the total the filter matched."""
        try:
            with _session_scope(self._database_url) as session:
                conditions = []
                if staff_id is not None:
                    conditions.append(AuditLogRow.staff_id == staff_id)
                if action_type is not None:
                    conditions.append(AuditLogRow.action_type == action_type)
                if status is not None:
                    conditions.append(AuditLogRow.status == status)
                if date_from is not None:
                    conditions.append(AuditLogRow.created_at >= date_from)
                if date_to is not None:
                    conditions.append(AuditLogRow.created_at <= date_to)
                where = tuple(conditions)

                total = session.scalar(select(func.count()).select_from(AuditLogRow).where(*where))
                rows = session.scalars(
                    select(AuditLogRow)
                    .where(*where)
                    .order_by(AuditLogRow.created_at.desc(), AuditLogRow.id.desc())
                    .limit(limit)
                    .offset(offset)
                ).all()
                return [_to_entry(row) for row in rows], int(total or 0)
        except SQLAlchemyError as exc:
            raise AuditStoreError("audit store is unreachable") from exc


def new_audit_id() -> str:
    return uuid.uuid4().hex


def _to_entry(row: AuditLogRow) -> AuditLogEntry:
    payload = json.loads(row.payload_json)
    # Nothing writes anything else; a row that says otherwise is data
    # corruption, not a status to render.
    if row.status == "PENDING":
        status: AuditStatus = "PENDING"
    elif row.status == "SUCCESS":
        status = "SUCCESS"
    elif row.status == "FAILED":
        status = "FAILED"
    else:
        raise AuditStoreError("audit store holds an unknown status")
    if row.action_type not in AUDIT_ACTIONS:
        raise AuditStoreError("audit store holds an unknown action type")
    return AuditLogEntry(
        id=row.id,
        created_at=row.created_at,
        staff_id=row.staff_id,
        staff_email=row.staff_email,
        staff_role=row.staff_role,
        action_type=row.action_type,
        target_system_url=row.target_system_url,
        payload=payload,
        biometric_confidence_score=row.biometric_confidence_score,
        status=status,
        error_response=row.error_response,
        completed_at=row.completed_at,
    )


# -- The append-only guarantees (raw DDL; SQLAlchemy cannot express triggers) ---

#: Every column that must keep its value across the single allowed transition.
#: `error_response`, `completed_at` and `status` are the outcome itself and are
#: deliberately absent.
_SQLITE_IMMUTABLE = """\
    OLD.status IS 'PENDING'
    AND NEW.status IS NOT 'PENDING'
    AND NEW.status IN ('SUCCESS', 'FAILED')
    AND NEW.id IS OLD.id
    AND NEW.created_at IS OLD.created_at
    AND NEW.staff_id IS OLD.staff_id
    AND NEW.staff_email IS OLD.staff_email
    AND NEW.staff_role IS OLD.staff_role
    AND NEW.action_type IS OLD.action_type
    AND NEW.target_system_url IS OLD.target_system_url
    AND NEW.payload_json IS OLD.payload_json
    AND NEW.biometric_confidence_score IS OLD.biometric_confidence_score\
"""

#: The same rule with PostgreSQL's null-safe comparison.
_PG_IMMUTABLE = """\
    OLD.status = 'PENDING'
    AND NEW.status IN ('SUCCESS', 'FAILED')
    AND NEW.id = OLD.id
    AND NEW.created_at = OLD.created_at
    AND NEW.staff_id = OLD.staff_id
    AND NEW.staff_email = OLD.staff_email
    AND NEW.staff_role = OLD.staff_role
    AND NEW.action_type = OLD.action_type
    AND NEW.target_system_url IS NOT DISTINCT FROM OLD.target_system_url
    AND NEW.payload_json = OLD.payload_json
    AND NEW.biometric_confidence_score IS NOT DISTINCT FROM OLD.biometric_confidence_score\
"""

_PG_FUNCTION = f"""\
CREATE OR REPLACE FUNCTION audit_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '{_MSG_DELETE}';
    END IF;
    IF NOT ({_PG_IMMUTABLE}) THEN
        RAISE EXCEPTION '{_MSG_UPDATE}';
    END IF;
    RETURN NEW;
END;
$$\
"""


def _ensure_append_only(engine: Engine) -> None:
    """Install (or reinstall) the guard triggers; runs on every construction.

    `DROP ... IF EXISTS` then `CREATE`, because there is no migration
    framework and the schema is created at startup: rerunning must be a
    no-op on SQLite and PostgreSQL alike. The two dialects spell refusal
    differently - `RAISE(ABORT, ...)` inline for SQLite, a plpgsql function
    for PostgreSQL - so the DDL branches rather than pretending to be portable.
    """
    if engine.dialect.name == "sqlite":
        with engine.begin() as conn:
            conn.exec_driver_sql("DROP TRIGGER IF EXISTS audit_logs_no_delete")
            conn.exec_driver_sql("DROP TRIGGER IF EXISTS audit_logs_guard")
            conn.exec_driver_sql(
                "CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs "
                f"BEGIN SELECT RAISE(ABORT, '{_MSG_DELETE}'); END"
            )
            conn.exec_driver_sql(
                "CREATE TRIGGER audit_logs_guard BEFORE UPDATE ON audit_logs "
                f"BEGIN SELECT RAISE(ABORT, '{_MSG_UPDATE}') "
                f"WHERE NOT ({_SQLITE_IMMUTABLE}); END"
            )
    else:
        with engine.begin() as conn:
            conn.exec_driver_sql(_PG_FUNCTION)
            conn.exec_driver_sql("DROP TRIGGER IF EXISTS audit_logs_guard ON audit_logs")
            conn.exec_driver_sql(
                "CREATE TRIGGER audit_logs_guard BEFORE UPDATE OR DELETE ON audit_logs "
                "FOR EACH ROW EXECUTE FUNCTION audit_logs_guard()"
            )


# -- Engine plumbing (the same shape as record_store) ---------------------------


@lru_cache(maxsize=8)
def _engine_for(database_url: str) -> Engine:
    """One engine per DSN; SQLite gets `check_same_thread=False` for workers."""
    connect_args: dict[str, bool] = (
        {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    )
    return create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)


@lru_cache(maxsize=8)
def _sessionmaker_for(database_url: str) -> sessionmaker[Session]:
    return sessionmaker(bind=_engine_for(database_url), expire_on_commit=False)


@contextmanager
def _session_scope(database_url: str) -> Iterator[Session]:
    """Commit on success, roll back on failure, always close (§29)."""
    session = _sessionmaker_for(database_url)()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
