"""The uploaded-record store (D23): bulk rows waiting to be verified.

Two tables in one store, because they exist for the same feature: the records
a CSV or Excel upload produced, and the one reusable column mapping the
"Map fields" step can remember for next time. Same trade-offs as the account
and posting-settings stores — schema at first use rather than Alembic,
blocking calls run in a worker thread, and no DSN or SQL ever escapes this
module (§29).

Storage shares the account store's database (`DATABASE_URL`, else
`backend/var/auth.db`): one deployment, one place to back up.

A record carries only the nine §14 identity fields the mapping produced — no
file bytes, no column headers — so a stored row is exactly what the
verification form will show and nothing more (§29).
"""

from __future__ import annotations

import json
import logging
import time
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

logger = logging.getLogger("camdx.records")

#: A record's lifecycle, as the store persists it (D23).
RecordStatusValue = Literal["pending", "verified"]

#: The fixed id of the single saved mapping row (D23): one reusable default,
#: exactly like the posting settings — the dialog pre-applies it when the next
#: file's columns line up.
DEFAULT_MAPPING_ID = "default"

#: Every search term is matched with SQL LIKE, so the LIKE wildcards in what
#: the user typed are escaped rather than interpreted (they search for data,
#: not patterns).
_LIKE_SPECIALS = ("\\", "%", "_")


class RecordStoreError(RuntimeError):
    """The record store could not be queried or reached (§28)."""


@dataclass(frozen=True)
class StoredRecord:
    """One uploaded row: the nine field values plus its lifecycle state."""

    id: str
    status: RecordStatusValue
    values: dict[str, str]
    verification: dict[str, object] | None
    created_at: float
    verified_at: float | None


class _Base(DeclarativeBase):
    pass


class UploadedRecordRow(_Base):
    """One row a CSV/Excel upload created, pending or verified."""

    __tablename__ = "uploaded_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    #: `pending` or `verified`.
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    #: JSON object of the nine §14 field names to their values.
    values_json: Mapped[str] = mapped_column(Text, nullable=False)
    #: Space-joined field *values*, lowercased — what `search` matches, so a
    #: lookup never hits a field name and returns every row.
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    #: JSON object of the stored verification outcome once verified (D23).
    verification_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    verified_at: Mapped[float | None] = mapped_column(Float, nullable=True)


class UploadMappingRow(_Base):
    """The single saved column → §14 field mapping (D23)."""

    __tablename__ = "upload_mappings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    mapping_json: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[float] = mapped_column(Float, nullable=False)


def resolve_record_database_url(database_url: str | None) -> str:
    """Same decision as the account store: `DATABASE_URL`, else `var/auth.db`.

    One database per deployment, so records, mappings, accounts and posting
    settings are created and backed up together.
    """
    return resolve_auth_database_url(database_url)


class RecordStore:
    """Blocking reads and writes for uploaded records. One instance per app."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        try:
            _Base.metadata.create_all(_engine_for(database_url))
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc

    def list_records(
        self,
        *,
        search: str | None,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[StoredRecord], int]:
        """A filtered page, newest first, plus the total the filter matched."""
        try:
            with _session_scope(self._database_url) as session:
                conditions = []
                if status is not None:
                    conditions.append(UploadedRecordRow.status == status)
                if search:
                    pattern = f"%{_escape_like(search)}%"
                    conditions.append(UploadedRecordRow.search_text.like(pattern, escape="\\"))
                where = tuple(conditions)

                total = session.scalar(
                    select(func.count()).select_from(UploadedRecordRow).where(*where)
                )
                rows = session.scalars(
                    select(UploadedRecordRow)
                    .where(*where)
                    .order_by(UploadedRecordRow.created_at.desc(), UploadedRecordRow.id.desc())
                    .limit(limit)
                    .offset(offset)
                ).all()
                return [_to_record(row) for row in rows], int(total or 0)
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc

    def add_records(self, records: list[StoredRecord]) -> None:
        """Persist the whole batch in one transaction (all or nothing)."""
        try:
            with _session_scope(self._database_url) as session:
                for record in records:
                    session.add(
                        UploadedRecordRow(
                            id=record.id,
                            status=record.status,
                            values_json=json.dumps(record.values, sort_keys=True),
                            search_text=_search_text(record.values),
                            verification_json=None,
                            created_at=record.created_at,
                            verified_at=None,
                        )
                    )
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc

    def get_record(self, record_id: str) -> StoredRecord | None:
        """One record by id, or `None` when it does not exist."""
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(UploadedRecordRow, record_id)
                return _to_record(row) if row is not None else None
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc

    def update_verification(
        self, record_id: str, verification: dict[str, object], verified_at: float
    ) -> StoredRecord | None:
        """Store the outcome and flip the record to `verified`; `None` if absent."""
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(UploadedRecordRow, record_id)
                if row is None:
                    return None
                row.verification_json = json.dumps(verification, sort_keys=True)
                row.status = "verified"
                row.verified_at = verified_at
                session.flush()
                return _to_record(row)
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc

    def get_mapping(self) -> dict[str, str] | None:
        """The saved column mapping, or `None` when nothing was ever saved."""
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(UploadMappingRow, DEFAULT_MAPPING_ID)
                if row is None:
                    return None
                loaded = json.loads(row.mapping_json)
                return {str(key): str(value) for key, value in loaded.items()}
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc

    def save_mapping(self, mapping: dict[str, str]) -> None:
        """Upsert the single saved mapping row — replace whatever was there."""
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(UploadMappingRow, DEFAULT_MAPPING_ID)
                payload = json.dumps(mapping, sort_keys=True)
                if row is None:
                    session.add(
                        UploadMappingRow(
                            id=DEFAULT_MAPPING_ID,
                            mapping_json=payload,
                            updated_at=time.time(),
                        )
                    )
                else:
                    row.mapping_json = payload
                    row.updated_at = time.time()
        except SQLAlchemyError as exc:
            raise RecordStoreError("record store is unreachable") from exc


def new_record_id() -> str:
    return uuid.uuid4().hex


def _to_record(row: UploadedRecordRow) -> StoredRecord:
    values = json.loads(row.values_json)
    verification: dict[str, object] | None = None
    if row.verification_json is not None:
        loaded = json.loads(row.verification_json)
        verification = {str(key): value for key, value in loaded.items()}
    # Nothing writes anything else; a row that says otherwise is data
    # corruption, not a status to render.
    if row.status == "pending":
        status: RecordStatusValue = "pending"
    elif row.status == "verified":
        status = "verified"
    else:
        raise RecordStoreError("record store holds an unknown status")
    return StoredRecord(
        id=row.id,
        status=status,
        values={str(key): str(value) for key, value in values.items()},
        verification=verification,
        created_at=row.created_at,
        verified_at=row.verified_at,
    )


def _search_text(values: dict[str, str]) -> str:
    return " ".join(value for value in values.values() if value).lower()


def _escape_like(term: str) -> str:
    escaped = term.lower()
    for special in _LIKE_SPECIALS:
        escaped = escaped.replace(special, f"\\{special}")
    return escaped


# -- Engine plumbing (the same shape as auth_store) ---------------------------


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
