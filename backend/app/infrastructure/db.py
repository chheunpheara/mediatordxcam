"""The sample identity registry (D13): one table of records to verify against.

Verification needs something to compare against. Until CamDigiKey is wired in
(`docs/camdx-integration.md`), that is this table: three obviously-fake records
seeded idempotently at startup, queried by national ID. It is deliberately not
biometric — §29 forbids persisting biometric data, and none is stored here; the
rows hold the same nine §14 text fields the form holds.

Schema management is `CREATE TABLE IF NOT EXISTS` at startup, not Alembic: with
one table and no deployed history to migrate, a migration framework would be
machinery without a job. It arrives when the schema has more than one version
worth preserving.

Both functions are blocking by design — SQLAlchemy is synchronous, so callers
run them in a worker thread (`asyncio.to_thread`) rather than on the event
loop. Errors are wrapped in `RegistryUnavailableError` so no driver message,
DSN or SQL ever escapes this module (§28).
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import fields as dataclass_fields
from functools import lru_cache

from sqlalchemy import String, create_engine, insert, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.domain.models import IdentityData

logger = logging.getLogger("camdx.db")


class RegistryUnavailableError(RuntimeError):
    """The registry could not be queried or reached.

    Carries no DSN, driver text or SQL (§28); the layer above translates it
    into a business error for the client.
    """


class _Base(DeclarativeBase):
    """Declarative base scoped to this schema."""


class IdentityRecordRow(_Base):
    """One stored identity record, keyed by national ID (§14).

    Columns are nullable even though the samples fill every field: a record
    missing a value is `not_checked` for that field, never a mismatch
    (`domain/verification.py`), and the schema should be able to say that.
    """

    __tablename__ = "identity_records"

    national_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    first_name_khmer: Mapped[str | None] = mapped_column(String(120))
    last_name_khmer: Mapped[str | None] = mapped_column(String(120))
    first_name_english: Mapped[str | None] = mapped_column(String(160))
    last_name_english: Mapped[str | None] = mapped_column(String(160))
    date_of_birth: Mapped[str | None] = mapped_column(String(10))
    gender: Mapped[str | None] = mapped_column(String(16))
    issued_date: Mapped[str | None] = mapped_column(String(10))
    expiry_date: Mapped[str | None] = mapped_column(String(10))

    def to_identity(self) -> IdentityData:
        """Map onto the domain value object the comparison rules consume."""
        return IdentityData(
            national_id=self.national_id,
            first_name_khmer=self.first_name_khmer,
            last_name_khmer=self.last_name_khmer,
            first_name_english=self.first_name_english,
            last_name_english=self.last_name_english,
            date_of_birth=self.date_of_birth,
            gender=self.gender,
            issued_date=self.issued_date,
            expiry_date=self.expiry_date,
        )


#: The records every fresh database starts with (D13). Unmistakably fake, per
#: the mock-data rule (§16): a reader who sees `SAMPLE` or `000000000000` knows
#: the value came from a fixture rather than from a government service.
#:
#: * `000000000000` — the card the mock OCR reads. OCR leaves the date of birth
#:   blank, so entering the stored one (`1992-07-18`) completes the match; any
#:   other date demonstrates §26's partial result with exactly one difference.
#: * `123456789` — the identity the workspace form starts from in tests.
#: * `111111111` — a known record with a deliberately unusual date of birth and
#:   gender, so a card-processed identity that only swaps the national ID
#:   demonstrates a multi-field partial.
SAMPLE_IDENTITIES: tuple[IdentityData, ...] = (
    IdentityData(
        national_id="000000000000",
        first_name_khmer="\u1798\u17d2\u179a\u17b8\u1798\u17c1",
        last_name_khmer="\u179a\u17b7\u1794\u1780",
        first_name_english="SAMPLE",
        last_name_english="PERSON",
        date_of_birth="1992-07-18",
        gender="M",
        issued_date="2020-01-01",
        expiry_date="2030-01-01",
    ),
    IdentityData(
        national_id="123456789",
        first_name_khmer="\u179f\u17d2\u179c\u17b7\u1799",
        last_name_khmer="\u1780\u17d2\u179a\u17b8\u1799",
        first_name_english="Sokha",
        last_name_english="Cham",
        date_of_birth="1994-02-11",
        gender="F",
        issued_date="2021-04-12",
        expiry_date="2029-04-12",
    ),
    IdentityData(
        national_id="111111111",
        first_name_khmer="\u1798\u17d2\u179a\u17b8\u1798\u17c1",
        last_name_khmer="\u179a\u17b7\u1794\u1780",
        first_name_english="SAMPLE",
        last_name_english="PARTIAL",
        date_of_birth="1975-11-30",
        gender="F",
        issued_date="2020-01-01",
        expiry_date="2030-01-01",
    ),
)


def init_database(database_url: str) -> int:
    """Create the schema and insert any sample record that is missing.

    Returns how many records were inserted. Existing rows are never overwritten
    or deleted: an operator who edited a sample keeps that edit across restarts,
    and re-running at every startup is what makes the seed idempotent.

    Also the startup health check — `create_all` opens a connection, so an
    unreachable or misconfigured DSN raises here rather than at the first
    verification request (fail fast; §21's "never silently fall back" applied
    to the registry).
    """
    engine = _engine_for(database_url)
    _Base.metadata.create_all(engine)
    return _seed(database_url)


def find_identity_record(database_url: str, national_id: str) -> IdentityData | None:
    """Look up one record by national ID. `None` means the ID is unknown.

    Blocking; run it in a worker thread. A database fault raises
    `RegistryUnavailableError`, never a driver exception.
    """
    try:
        with _session_scope(database_url) as session:
            row = session.get(IdentityRecordRow, national_id)
            return row.to_identity() if row is not None else None
    except SQLAlchemyError as exc:
        raise RegistryUnavailableError("identity registry is unreachable") from exc


def _seed(database_url: str) -> int:
    """Insert sample records that are not present yet. Returns the count."""
    with _session_scope(database_url) as session:
        existing = set(session.scalars(select(IdentityRecordRow.national_id)))
        missing: list[dict[str, str | None]] = []
        for identity in SAMPLE_IDENTITIES:
            values = _row_values(identity)
            if values["national_id"] not in existing:
                missing.append(values)
        if missing:
            # One executemany insert; the rows are data, not ORM objects, so
            # seeding never attaches a shared instance to a session.
            session.execute(insert(IdentityRecordRow), missing)
        logger.info(
            "identity registry seeded",
            extra={"inserted": len(missing), "total": len(existing) + len(missing)},
        )
        return len(missing)


def _row_values(identity: IdentityData) -> dict[str, str | None]:
    """Column-keyed values for one sample record, all columns present."""
    if identity.national_id is None:
        raise ValueError("a sample identity record must have a national_id")
    return {f.name: getattr(identity, f.name) for f in dataclass_fields(IdentityData)}


@lru_cache(maxsize=8)
def _engine_for(database_url: str) -> Engine:
    """One engine per DSN for the process lifetime.

    SQLite (tests) gets `check_same_thread=False`: `asyncio.to_thread` runs
    queries on worker threads that did not create the connection. PostgreSQL
    never sees that option — it is gated on the scheme, because psycopg would
    reject an unknown connect argument.
    """
    connect_args: dict[str, bool] = (
        {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    )
    return create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)


@lru_cache(maxsize=8)
def _sessionmaker_for(database_url: str) -> sessionmaker[Session]:
    """Session factory bound to the cached engine for this DSN."""
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
