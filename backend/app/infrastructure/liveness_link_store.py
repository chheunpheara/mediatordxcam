"""Per-customer liveness links: one secret display URL per officer.

A link is a row with its own token; the customer monitor opens
`/display?session=<token>` and the officer's panel joins the same room. The
token is minted once and never rewritten — expiry and supersession live in
their own columns, so a URL that has already been handed out keeps resolving
to the same link for exactly as long as it is valid.

One officer holds at most one *usable* link: minting a new one stamps
`superseded_at` onto the previous usable row. Expired rows stay put, so the
officer can still see what happened to a link the customer screen refused.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal
from uuid import uuid4

from sqlalchemy import Float, String, create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.sql import Select, select

from app.infrastructure.auth_store import resolve_auth_database_url

#: What a link is doing right now. Derived from the clock, never stored, so the
#: three states can never drift apart from `expires_at` / `superseded_at`.
LinkStatus = Literal["in_use", "superseded", "expired"]


@dataclass(frozen=True)
class LivenessLink:
    """One minted link. Read-only: the store only ever inserts rows."""

    id: str
    owner_id: str
    customer: str
    token: str
    created_at: float
    expires_at: float
    superseded_at: float | None = None

    @property
    def usable(self) -> bool:
        return self.superseded_at is None and self.expires_at > time.time()

    def status(self, now: float) -> LinkStatus:
        # Expiry outranks supersession: a link the clock has already killed is
        # expired whichever way it stopped being the officer's current one.
        if self.expires_at <= now:
            return "expired"
        if self.superseded_at is not None:
            return "superseded"
        return "in_use"


class _Base(DeclarativeBase):
    pass


class LivenessLinkRow(_Base):
    __tablename__ = "liveness_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    customer: Mapped[str] = mapped_column(String(120), nullable=False)
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    expires_at: Mapped[float] = mapped_column(Float, nullable=False)
    superseded_at: Mapped[float | None] = mapped_column(Float, nullable=True)


class LivenessLinkStore:
    """The link table.

    Writes only ever insert a row or stamp `superseded_at`: a token or an
    expiry that has been handed out is fixed, which is what makes the URL on
    the customer monitor trustworthy between reloads.
    """

    def __init__(self, database_url: str) -> None:
        self._database_url = resolve_auth_database_url(database_url)
        try:
            _Base.metadata.create_all(_engine_for(self._database_url))
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness link store is unreachable") from exc

    def create(
        self, *, owner_id: str, customer: str, expires_at: float
    ) -> tuple[LivenessLink, bool]:
        """Mint a link, superseding the owner's current one if there is one.

        Returns the new link plus whether a previous usable link stopped
        working — the caller reports that, because a URL may already be open
        on a customer monitor.
        """
        now = time.time()
        try:
            with _session_scope(self._database_url) as session:
                superseded_previous = False
                current = session.scalars(
                    select(LivenessLinkRow).where(
                        LivenessLinkRow.owner_id == owner_id,
                        LivenessLinkRow.superseded_at.is_(None),
                        LivenessLinkRow.expires_at > now,
                    )
                ).all()
                for row in current:
                    row.superseded_at = now
                    superseded_previous = True
                row = LivenessLinkRow(
                    id=uuid4().hex,
                    owner_id=owner_id,
                    customer=customer,
                    token=secrets.token_urlsafe(24),
                    created_at=now,
                    expires_at=expires_at,
                )
                session.add(row)
                session.flush()
                return _to_link(row), superseded_previous
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness link store is unreachable") from exc

    def list_for_owner(self, owner_id: str) -> list[LivenessLink]:
        """Every link the officer ever minted, newest first."""
        return self._list(
            select(LivenessLinkRow)
            .where(LivenessLinkRow.owner_id == owner_id)
            .order_by(LivenessLinkRow.created_at.desc())
        )

    def list_all(self) -> list[LivenessLink]:
        """Every link of every officer, newest first (administrator view)."""
        return self._list(select(LivenessLinkRow).order_by(LivenessLinkRow.created_at.desc()))

    def find_by_token(self, token: str) -> LivenessLink | None:
        """The link behind a `?session=` token, or `None` for an unknown one."""
        try:
            with _session_scope(self._database_url) as session:
                row = session.scalar(select(LivenessLinkRow).where(LivenessLinkRow.token == token))
                return _to_link(row) if row is not None else None
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness link store is unreachable") from exc

    def _list(self, statement: Select[LivenessLinkRow]) -> list[LivenessLink]:
        try:
            with _session_scope(self._database_url) as session:
                return [_to_link(row) for row in session.scalars(statement).all()]
        except SQLAlchemyError as exc:
            raise RuntimeError("liveness link store is unreachable") from exc


def _to_link(row: LivenessLinkRow) -> LivenessLink:
    return LivenessLink(
        id=row.id,
        owner_id=row.owner_id,
        customer=row.customer,
        token=row.token,
        created_at=row.created_at,
        expires_at=row.expires_at,
        superseded_at=row.superseded_at,
    )


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
