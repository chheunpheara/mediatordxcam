"""The account store (D18): users, roles, permissions and sessions.

The RBAC side of the product. Where `infrastructure/db.py` holds the identity
records verification compares *against*, this module holds the accounts that
are allowed to verify at all: which person signed in, which roles they hold,
which of the six CamDigiKey APIs each role may call, and the sessions that prove
a request came from a signed-in user.

Same deliberate trade-offs as the registry:

* Schema management is `CREATE TABLE IF NOT EXISTS` at first use, not Alembic
  (see `db.py` for the reasoning) — four small tables with no deployed history.
* Everything is blocking by design; callers run it in a worker thread
  (`asyncio.to_thread`), wrapped here in `AuthStoreError` so no driver text, DSN
  or SQL ever escapes (§28).
* Its own declarative metadata, deliberately separate from the registry's: the
  two schemas never migrate together, and a test can create one without the
  other.

Storage location (D18): the `DATABASE_URL` database when one is configured —
the Docker stack's PostgreSQL, so accounts survive restarts — and otherwise a
local SQLite file under `backend/var/`, so `make backend-run` works with no
database at all. `resolve_auth_database_url` is the single place that decides.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Boolean, Float, ForeignKey, String, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.core.config import BACKEND_ROOT
from app.domain.auth import ALL_PERMISSIONS, Role, User, UserStatus
from app.domain.enums import VerificationMethod

logger = logging.getLogger("camdx.auth")

#: Seeded role name of the built-in administrator role (D18).
ADMIN_ROLE_NAME = "Admin"
#: The default account the product boots with (requirement 5). Its password is
#: a documented placeholder for local use; every real deployment must change it.
SEED_ADMIN_EMAIL = "admin@gmail.com"
SEED_ADMIN_NAME = "Administrator"


class AuthStoreError(RuntimeError):
    """The account store could not be queried or reached.

    Carries no DSN, driver text or SQL (§28); the service layer translates it
    into a business error for the client.
    """


class DuplicateEmailError(Exception):
    """An account with that email already exists."""


class DuplicateRoleNameError(Exception):
    """A role with that name already exists."""


class RoleInUseError(Exception):
    """A role still has holders, so deleting it would orphan them."""

    def __init__(self, role_id: str) -> None:
        self.role_id = role_id
        super().__init__("role is still assigned to users")


class UnknownRoleError(Exception):
    """A referenced role id does not exist."""

    def __init__(self, missing: set[str]) -> None:
        self.missing = missing
        super().__init__("unknown role")


class _Base(DeclarativeBase):
    """Declarative base scoped to the auth schema."""


class RoleRow(_Base):
    """One role: a name plus optional admin rights. Permissions live in the join table."""

    __tablename__ = "auth_roles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)


class RolePermissionRow(_Base):
    """One (role, permission) pair. A permission key is a `VerificationMethod` value."""

    __tablename__ = "auth_role_permissions"

    role_id: Mapped[str] = mapped_column(String(36), ForeignKey("auth_roles.id"), primary_key=True)
    permission: Mapped[str] = mapped_column(String(64), primary_key=True)


class UserRow(_Base):
    """One account. `password_hash` never leaves this layer unhashed (§30)."""

    __tablename__ = "auth_users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(16), default=UserStatus.ACTIVE.value)


class UserRoleRow(_Base):
    """A (user, role) link. Users may hold several roles (D18)."""

    __tablename__ = "auth_user_roles"

    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("auth_users.id"), primary_key=True)
    role_id: Mapped[str] = mapped_column(String(36), ForeignKey("auth_roles.id"), primary_key=True)


class SessionRow(_Base):
    """One signed-in session: an opaque bearer token bound to a user.

    Keyed by the token itself, so lookup is a single indexed read and revoking a
    session is deleting its row. `expires_at` is epoch seconds (UTC) rather than
    a timestamp column, so SQLite and PostgreSQL compare identically.
    """

    __tablename__ = "auth_sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("auth_users.id"), index=True)
    expires_at: Mapped[float] = mapped_column(Float)
    created_at: Mapped[float] = mapped_column(Float)


#: The roles every fresh database starts with (requirement 4). The two loan
#: officer roles are the business seeding: "Loan Officer" may call APIs 1-2,
#: "Senior Loan Officer" everything — and "Admin" adds the right to manage
#: accounts, with all six permissions so administration never narrows access.
_SEED_ROLES: tuple[tuple[str, bool, tuple[VerificationMethod, ...]], ...] = (
    (ADMIN_ROLE_NAME, True, tuple(sorted(ALL_PERMISSIONS, key=str))),
    (
        "Loan Officer",
        False,
        (
            VerificationMethod.VERIFY_USER_INFO,
            VerificationMethod.VERIFY_USER_INFO_FACE,
        ),
    ),
    ("Senior Loan Officer", False, tuple(sorted(ALL_PERMISSIONS, key=str))),
)


def resolve_auth_database_url(database_url: str | None) -> str:
    """Where the account store lives (D18).

    A configured `DATABASE_URL` wins — one database per deployment, seeded and
    backed up together. With none (fixtures mode, `make backend-run` without a
    `.env`), a local SQLite file under `backend/var/` keeps login working out
    of the box; `var/` is git-ignored, so it never reaches a commit.
    """
    if database_url:
        return database_url
    path = BACKEND_ROOT / "var" / "auth.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{path}"


class AuthStore:
    """Blocking CRUD for accounts, roles and sessions.

    One instance per application. Construction creates the schema and runs the
    idempotent seed — cheap, and it means a fresh database is usable without a
    separate migration step.
    """

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        try:
            _Base.metadata.create_all(_engine_for(database_url))
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    # -- Seed -------------------------------------------------------------

    def ensure_seeded(self, *, admin_password_hash: str) -> None:
        """Insert the seeded roles and the default admin if they are missing.

        Idempotent by natural key (role name, user email): existing rows are
        never overwritten, so an operator who renamed or re-locked the default
        account keeps that change across restarts — while a deleted seed role
        or account is restored at the next startup, the same contract the
        identity registry makes (`db.py`).
        """
        try:
            with _session_scope(self._database_url) as session:
                role_ids = _ensure_seed_roles(session)
                _ensure_seed_admin(session, role_ids, admin_password_hash)
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    # -- Users ------------------------------------------------------------

    def find_user_with_credentials(self, email: str) -> tuple[User, str] | None:
        """The account for this email plus its password hash, or `None`."""
        try:
            with _session_scope(self._database_url) as session:
                row = session.scalar(select(UserRow).where(UserRow.email == email))
                if row is None:
                    return None
                return _to_user(session, row), row.password_hash
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def get_user(self, user_id: str) -> User | None:
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(UserRow, user_id)
                return _to_user(session, row) if row is not None else None
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def list_users(self) -> list[User]:
        try:
            with _session_scope(self._database_url) as session:
                rows = session.scalars(select(UserRow).order_by(UserRow.email)).all()
                return [_to_user(session, row) for row in rows]
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def create_user(
        self, *, email: str, name: str, password_hash: str, role_ids: Sequence[str]
    ) -> User:
        try:
            with _session_scope(self._database_url) as session:
                _require_roles_exist(session, role_ids)
                row = UserRow(
                    id=uuid.uuid4().hex,
                    email=email,
                    name=name,
                    password_hash=password_hash,
                    status=UserStatus.ACTIVE.value,
                )
                session.add(row)
                session.flush()
                for role_id in dict.fromkeys(role_ids):
                    session.add(UserRoleRow(user_id=row.id, role_id=role_id))
                session.flush()
                return _to_user(session, row)
        except IntegrityError as exc:
            raise DuplicateEmailError from exc
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def update_user(
        self,
        user_id: str,
        *,
        name: str | None = None,
        role_ids: Sequence[str] | None = None,
        status: UserStatus | None = None,
        password_hash: str | None = None,
    ) -> User | None:
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(UserRow, user_id)
                if row is None:
                    return None
                if name is not None:
                    row.name = name
                if status is not None:
                    row.status = status.value
                if password_hash is not None:
                    row.password_hash = password_hash
                if role_ids is not None:
                    _require_roles_exist(session, role_ids)
                    session.query(UserRoleRow).filter(UserRoleRow.user_id == user_id).delete()
                    for role_id in dict.fromkeys(role_ids):
                        session.add(UserRoleRow(user_id=user_id, role_id=role_id))
                session.flush()
                return _to_user(session, row)
        except IntegrityError as exc:
            raise AuthStoreError("account already exists") from exc
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def delete_user(self, user_id: str) -> bool:
        try:
            with _session_scope(self._database_url) as session:
                session.query(UserRoleRow).filter(UserRoleRow.user_id == user_id).delete()
                session.query(SessionRow).filter(SessionRow.user_id == user_id).delete()
                row = session.get(UserRow, user_id)
                if row is None:
                    return False
                session.delete(row)
                return True
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def count_active_admins(self, *, excluding_user_id: str | None = None) -> int:
        """Active users holding at least one admin role, optionally excluding one.

        The guard behind "at least one administrator must remain": computed from
        the same rows the response would render, never from a cached flag.
        """
        try:
            with _session_scope(self._database_url) as session:
                users = session.scalars(
                    select(UserRow).where(UserRow.status == UserStatus.ACTIVE.value)
                )
                count = 0
                for row in users:
                    if excluding_user_id is not None and row.id == excluding_user_id:
                        continue
                    if _has_admin_role(session, row.id):
                        count += 1
                return count
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    # -- Roles ------------------------------------------------------------

    def list_roles(self) -> list[Role]:
        try:
            with _session_scope(self._database_url) as session:
                return _all_roles(session)
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def get_role(self, role_id: str) -> Role | None:
        try:
            with _session_scope(self._database_url) as session:
                return _load_role(session, role_id)
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def find_role_by_name(self, name: str) -> Role | None:
        try:
            with _session_scope(self._database_url) as session:
                row = session.scalar(select(RoleRow).where(RoleRow.name == name))
                return _load_role(session, row.id) if row is not None else None
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def create_role(
        self, *, name: str, is_admin: bool, permissions: Iterable[VerificationMethod]
    ) -> Role:
        try:
            with _session_scope(self._database_url) as session:
                row = RoleRow(id=uuid.uuid4().hex, name=name, is_admin=is_admin)
                session.add(row)
                session.flush()
                _set_permissions(session, row.id, set(permissions))
                session.flush()
                return _load_role(session, row.id) or Role(row.id, name, is_admin, frozenset())
        except IntegrityError as exc:
            raise DuplicateRoleNameError from exc
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def update_role(
        self,
        role_id: str,
        *,
        name: str | None = None,
        is_admin: bool | None = None,
        permissions: Iterable[VerificationMethod] | None = None,
    ) -> Role | None:
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(RoleRow, role_id)
                if row is None:
                    return None
                if name is not None:
                    row.name = name
                if is_admin is not None:
                    row.is_admin = is_admin
                if permissions is not None:
                    _set_permissions(session, role_id, set(permissions))
                session.flush()
                return _load_role(session, role_id)
        except IntegrityError as exc:
            raise DuplicateRoleNameError from exc
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def delete_role(self, role_id: str) -> bool:
        try:
            with _session_scope(self._database_url) as session:
                holders = session.scalar(
                    select(UserRoleRow.user_id).where(UserRoleRow.role_id == role_id).limit(1)
                )
                if holders is not None:
                    raise RoleInUseError(role_id)
                session.query(RolePermissionRow).filter(
                    RolePermissionRow.role_id == role_id
                ).delete()
                row = session.get(RoleRow, role_id)
                if row is None:
                    return False
                session.delete(row)
                return True
        except RoleInUseError:
            raise
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    # -- Sessions ---------------------------------------------------------

    def create_session(self, *, token: str, user_id: str, expires_at: float, now: float) -> None:
        try:
            with _session_scope(self._database_url) as session:
                session.add(
                    SessionRow(token=token, user_id=user_id, expires_at=expires_at, created_at=now)
                )
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def resolve_session(self, token: str, *, now: float) -> User | None:
        """The signed-in user for this token, or `None` when it proves nothing.

        `None` covers every reason a token is not usable — unknown, expired,
        belonging to a disabled account — because the caller can only safely
        answer "sign in again" for all of them, and distinguishing them would
        tell an attacker which tokens were once valid.
        """
        try:
            with _session_scope(self._database_url) as session:
                row = session.get(SessionRow, token)
                if row is None:
                    return None
                if row.expires_at <= now:
                    session.delete(row)
                    return None
                user_row = session.get(UserRow, row.user_id)
                if user_row is None or user_row.status != UserStatus.ACTIVE.value:
                    return None
                return _to_user(session, user_row)
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def revoke_session(self, token: str) -> None:
        try:
            with _session_scope(self._database_url) as session:
                session.query(SessionRow).filter(SessionRow.token == token).delete()
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def revoke_user_sessions(self, user_id: str) -> None:
        try:
            with _session_scope(self._database_url) as session:
                session.query(SessionRow).filter(SessionRow.user_id == user_id).delete()
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc

    def delete_expired_sessions(self, *, now: float) -> int:
        try:
            with _session_scope(self._database_url) as session:
                return session.query(SessionRow).filter(SessionRow.expires_at <= now).delete()
        except SQLAlchemyError as exc:
            raise AuthStoreError("account store is unreachable") from exc


# -- Row → domain mapping ----------------------------------------------------


def _to_user(session: Session, row: UserRow) -> User:
    role_ids = session.scalars(
        select(UserRoleRow.role_id).where(UserRoleRow.user_id == row.id)
    ).all()
    roles = tuple(
        role for role_id in role_ids if (role := _load_role(session, role_id)) is not None
    )
    return User(
        id=row.id,
        email=row.email,
        name=row.name,
        status=UserStatus(row.status),
        roles=roles,
    )


def _has_admin_role(session: Session, user_id: str) -> bool:
    role_ids = session.scalars(
        select(UserRoleRow.role_id).where(UserRoleRow.user_id == user_id)
    ).all()
    for role_id in role_ids:
        row = session.get(RoleRow, role_id)
        if row is not None and row.is_admin:
            return True
    return False


def _all_roles(session: Session) -> list[Role]:
    rows = session.scalars(select(RoleRow).order_by(RoleRow.name)).all()
    permissions = _permissions_by_role(session)
    return [
        Role(
            id=row.id,
            name=row.name,
            is_admin=row.is_admin,
            permissions=permissions.get(row.id, frozenset()),
        )
        for row in rows
    ]


def _load_role(session: Session, role_id: str) -> Role | None:
    row = session.get(RoleRow, role_id)
    if row is None:
        return None
    permissions = _permissions_by_role(session)
    return Role(
        id=row.id,
        name=row.name,
        is_admin=row.is_admin,
        permissions=permissions.get(row.id, frozenset()),
    )


def _permissions_by_role(session: Session) -> dict[str, frozenset[VerificationMethod]]:
    pairs = session.execute(select(RolePermissionRow.role_id, RolePermissionRow.permission)).all()
    grouped: dict[str, set[VerificationMethod]] = {}
    for role_id, permission in pairs:
        grouped.setdefault(role_id, set()).add(VerificationMethod(permission))
    return {role_id: frozenset(values) for role_id, values in grouped.items()}


def _set_permissions(session: Session, role_id: str, permissions: set[VerificationMethod]) -> None:
    session.query(RolePermissionRow).filter(RolePermissionRow.role_id == role_id).delete()
    for permission in permissions:
        session.add(RolePermissionRow(role_id=role_id, permission=permission.value))


def _require_roles_exist(session: Session, role_ids: Sequence[str]) -> None:
    wanted = set(role_ids)
    found = set(session.scalars(select(RoleRow.id).where(RoleRow.id.in_(wanted))).all())
    if found != wanted:
        raise UnknownRoleError(wanted - found)


# -- Seed --------------------------------------------------------------------


def _ensure_seed_roles(session: Session) -> dict[str, str]:
    """Insert any missing seeded role. Returns name → id for every seed role."""
    existing = {row.name: row.id for row in session.scalars(select(RoleRow)).all()}
    for name, is_admin, permissions in _SEED_ROLES:
        if name in existing:
            continue
        row = RoleRow(id=uuid.uuid4().hex, name=name, is_admin=is_admin)
        session.add(row)
        session.flush()
        for permission in permissions:
            session.add(RolePermissionRow(role_id=row.id, permission=permission.value))
        existing[name] = row.id
        logger.info("role seeded", extra={"role": name})
    session.flush()
    return existing


def _ensure_seed_admin(session: Session, role_ids: dict[str, str], password_hash: str) -> None:
    existing = session.scalar(select(UserRow).where(UserRow.email == SEED_ADMIN_EMAIL))
    if existing is not None:
        return
    row = UserRow(
        id=uuid.uuid4().hex,
        email=SEED_ADMIN_EMAIL,
        name=SEED_ADMIN_NAME,
        password_hash=password_hash,
        status=UserStatus.ACTIVE.value,
    )
    session.add(row)
    session.flush()
    session.add(UserRoleRow(user_id=row.id, role_id=role_ids[ADMIN_ROLE_NAME]))
    logger.info("default admin seeded", extra={"email": SEED_ADMIN_EMAIL})


# -- Engine plumbing ----------------------------------------------------------


@lru_cache(maxsize=8)
def _engine_for(database_url: str) -> Engine:
    """One engine per DSN for the process lifetime.

    SQLite (tests and the no-database fallback) gets `check_same_thread=False`:
    `asyncio.to_thread` runs queries on worker threads that did not create the
    connection. PostgreSQL never sees that option — it is gated on the scheme,
    because psycopg would reject an unknown connect argument.
    """
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
