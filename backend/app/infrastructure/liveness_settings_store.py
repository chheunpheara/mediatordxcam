"""Liveness display settings: the fixed URL token for dual-screen use.

The admin enables a single static room; the corresponding `/display?session=`
URL can then be pasted once onto the customer monitor. Token persists so the
URL survives redeploys and refreshes.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy import Boolean, Float, String, create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.infrastructure.auth_store import resolve_auth_database_url

ROW_ID = "default"


@dataclass(frozen=True)
class LivenessSettings:
    enabled: bool
    token: str


class _Base(DeclarativeBase):
    pass


class LivenessSettingsRow(_Base):
    __tablename__ = "liveness_display_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    token: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    updated_at: Mapped[float] = mapped_column(Float, nullable=False)


class LivenessSettingsStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = resolve_auth_database_url(database_url)
        try:
            _Base.metadata.create_all(_engine_for(self._database_url))
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness settings store is unreachable") from exc

    def get(self) -> LivenessSettings:
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(LivenessSettingsRow, ROW_ID)
                if row is None:
                    row = LivenessSettingsRow(
                        id=ROW_ID,
                        enabled=False,
                        token=secrets.token_urlsafe(16),
                        created_at=time.time(),
                        updated_at=time.time(),
                    )
                    session.add(row)
                    session.flush()
                return LivenessSettings(enabled=row.enabled, token=row.token)
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness settings store is unreachable") from exc

    def set_enabled(self, enabled: bool) -> LivenessSettings:
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(LivenessSettingsRow, ROW_ID)
                if row is None:
                    row = LivenessSettingsRow(
                        id=ROW_ID,
                        enabled=enabled,
                        token=secrets.token_urlsafe(16),
                        created_at=time.time(),
                        updated_at=time.time(),
                    )
                    session.add(row)
                else:
                    row.enabled = enabled
                    row.updated_at = time.time()
                session.flush()
                return LivenessSettings(enabled=row.enabled, token=row.token)
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness settings store is unreachable") from exc


@lru_cache(maxsize=8)
def _engine_for(database_url: str) -> Engine:
    connect_args: dict[str, bool] = (
        {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    )
    return create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)


@lru_cache(maxsize=8)
def _sessionmaker_for(database_url: str) -> sessionmaker[Session]:
    return sessionmaker(bind=_engine_for(database_url), expire_on_commit=False)


@contextmanager
def _session_scope(database_url: str) -> Iterator[Session]:
    session = _sessionmaker_for(database_url)()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
