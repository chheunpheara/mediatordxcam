"""The core-system posting store (D19): where verification results are sent.

Third-party integration settings — system URL, API user, API password — for
"Post to Core Systems". Same trade-offs as the account store: schema at first
use rather than Alembic, blocking calls run in a worker thread, and no DSN,
SQL or stored credential ever escapes this module (§28).

Storage shares the account store's database (`DATABASE_URL`, else
`backend/var/auth.db`): one deployment, one place to back up, and the Docker
stack's PostgreSQL keeps the settings across restarts.

The API password is stored *recoverably* on purpose — unlike an account
password, it must be replayed as Basic auth to the third-party system on every
post, so a hash would make the feature impossible. It is therefore never
returned by any endpoint, never logged, and only ever leaves this process
inside an outbound request.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy import Float, String, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.infrastructure.auth_store import resolve_auth_database_url

logger = logging.getLogger("camdx.integrations")


class IntegrationStoreError(RuntimeError):
    """The integration store could not be queried or reached (§28)."""


@dataclass(frozen=True)
class IntegrationSetting:
    """One stored target. `api_password` never crosses the API boundary."""

    id: str
    url: str
    api_user: str
    api_password: str


class _Base(DeclarativeBase):
    pass


class IntegrationSettingRow(_Base):
    """One configured core system to post verification results to."""

    __tablename__ = "core_post_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    api_user: Mapped[str] = mapped_column(String(255), nullable=False)
    api_password: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    updated_at: Mapped[float] = mapped_column(Float, nullable=False)


def resolve_integration_database_url(database_url: str | None) -> str:
    """Same decision as the account store: `DATABASE_URL`, else `var/auth.db`.

    One database per deployment (and one fallback file), so both stores are
    created, seeded and backed up together.
    """
    return resolve_auth_database_url(database_url)


class IntegrationStore:
    """Blocking CRUD for posting settings. One instance per application."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        try:
            _Base.metadata.create_all(_engine_for(database_url))
        except SQLAlchemyError as exc:
            raise IntegrationStoreError("integration store is unreachable") from exc

    def list_settings(self) -> list[IntegrationSetting]:
        """Every configured target, passwords included (store-internal only)."""
        try:
            with _session_scope(self._database_url) as session:
                rows = session.scalars(
                    select(IntegrationSettingRow).order_by(IntegrationSettingRow.created_at)
                ).all()
                return [_to_setting(row) for row in rows]
        except SQLAlchemyError as exc:
            raise IntegrationStoreError("integration store is unreachable") from exc

    def replace_all(self, settings: list[IntegrationSetting]) -> None:
        """Persist exactly this list, atomically — the save operation (D19)."""
        now = time.time()
        try:
            with _session_scope(self._database_url) as session:
                for existing in session.scalars(select(IntegrationSettingRow)).all():
                    session.delete(existing)
                for setting in settings:
                    session.add(
                        IntegrationSettingRow(
                            id=setting.id,
                            url=setting.url,
                            api_user=setting.api_user,
                            api_password=setting.api_password,
                            created_at=now,
                            updated_at=now,
                        )
                    )
        except SQLAlchemyError as exc:
            raise IntegrationStoreError("integration store is unreachable") from exc


def new_setting_id() -> str:
    return uuid.uuid4().hex


def _to_setting(row: IntegrationSettingRow) -> IntegrationSetting:
    return IntegrationSetting(
        id=row.id,
        url=row.url,
        api_user=row.api_user,
        api_password=row.api_password,
    )


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
