"""Sign-in, sessions and account administration (D18).

The application layer over `infrastructure/auth_store`: it owns the password
policy, credential hashing, session issuing and every guard the admin endpoints
need (last-admin protection, self-deletion, role reuse). The store answers
"what is stored"; this module decides "may this happen".

Password hashing is stdlib `hashlib.scrypt` — a memory-hard KDF, no new
dependency, no hand-rolled primitive. Sessions are opaque random tokens stored
server-side, not self-contained signed claims: revoking a session (logout,
disabled account) takes effect on the next request instead of after a token
lifetime, which is exactly what "disable a user" has to mean.

Every blocking call runs in a worker thread (`asyncio.to_thread`): scrypt is
deliberately expensive, and a database round-trip must not stall the event loop.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import secrets
import time
from functools import lru_cache

from app.core.config import Settings
from app.core.errors import AppError, ErrorCode
from app.domain.auth import (
    ALL_PERMISSIONS,
    Role,
    User,
    UserStatus,
    password_policy_violation,
)
from app.domain.enums import OfficialApiName, VerificationMethod
from app.domain.requirements import requirements_for
from app.infrastructure.auth_store import (
    AuthStore,
    DuplicateEmailError,
    DuplicateRoleNameError,
    RoleInUseError,
    UnknownRoleError,
    resolve_auth_database_url,
)

logger = logging.getLogger("camdx.auth")

#: The account every fresh database starts with (requirement 5). A documented
#: placeholder for local use — the login page is where a deployment changes it.
DEFAULT_ADMIN_PASSWORD = "P4ssw0rd!"  # noqa: S105 - documented default credential (D18)

#: How long a session stays valid. Long enough for a working day, short enough
#: that a stolen token expires on its own.
SESSION_TTL_SECONDS = 12 * 60 * 60

#: scrypt parameters. n=2**14 (16 MiB) is OWASP's recommended floor for scrypt;
#: changing them only affects new hashes — old ones carry their own parameters.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SALT_BYTES = 16


def hash_password(password: str) -> str:
    """Hash a password with scrypt. Format: `scrypt$n$r$p$salt$digest` (b64)."""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )
    return (
        f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}"
        f"${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"
    )


def verify_password(password: str, encoded: str) -> bool:
    """Constant-time check of a password against a stored hash.

    Any malformed value answers `False` rather than raising: a corrupted hash
    must not become a 500 on the login path.
    """
    try:
        scheme, n, r, p, salt_b64, digest_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def new_session_token() -> str:
    """An opaque bearer token: 256 bits of CSPRNG output, URL-safe."""
    return secrets.token_urlsafe(32)


class AuthService:
    """Async facade over the account store.

    Constructed once per application (see `api/deps.py`). The constructor
    creates the schema and runs the idempotent seed, so it always runs in a
    worker thread.
    """

    def __init__(self, settings: Settings) -> None:
        self._store = AuthStore(resolve_auth_database_url(settings.database_url))
        self._store.ensure_seeded(admin_password_hash=hash_password(DEFAULT_ADMIN_PASSWORD))

    # -- Authentication ---------------------------------------------------

    async def login(self, email: str, password: str) -> tuple[User, str]:
        """Verify credentials and start a session.

        One message for every credential failure — wrong email and wrong
        password are indistinguishable, here and in the response, so the login
        form cannot be used to enumerate accounts (§30). The dummy hash on the
        unknown-email path keeps the two cases roughly equal in time, too.
        """
        normalized = email.strip().lower()
        found = await asyncio.to_thread(self._store.find_user_with_credentials, normalized)
        if found is None:
            await asyncio.to_thread(verify_password, password, _dummy_password_hash())
            raise _bad_credentials()
        user, password_hash = found
        if not await asyncio.to_thread(verify_password, password, password_hash):
            raise _bad_credentials()
        if not user.is_active:
            raise AppError(
                ErrorCode.FORBIDDEN,
                message="This account has been disabled. Please contact an administrator.",
            )

        token = new_session_token()
        now = time.time()
        await asyncio.to_thread(
            self._store.create_session,
            token=token,
            user_id=user.id,
            expires_at=now + SESSION_TTL_SECONDS,
            now=now,
        )
        await asyncio.to_thread(self._store.delete_expired_sessions, now=now)
        logger.info("login", extra={"user_id": user.id})
        return user, token

    async def logout(self, token: str) -> None:
        """End one session. Idempotent — logging out twice is not an error."""
        await asyncio.to_thread(self._store.revoke_session, token)

    async def resolve(self, token: str) -> User | None:
        """The active user behind this token, or `None` when it proves nothing."""
        return await asyncio.to_thread(self._store.resolve_session, token, now=time.time())

    # -- Users ------------------------------------------------------------

    async def list_users(self) -> list[User]:
        return await asyncio.to_thread(self._store.list_users)

    async def get_user(self, user_id: str) -> User:
        user = await asyncio.to_thread(self._store.get_user, user_id)
        if user is None:
            raise AppError(ErrorCode.NOT_FOUND, message="That account no longer exists.")
        return user

    async def create_user(
        self, *, email: str, name: str, password: str, role_ids: list[str]
    ) -> User:
        """Create an account, enforcing the password policy and email uniqueness."""
        violation = password_policy_violation(password)
        if violation:
            raise AppError(
                ErrorCode.INVALID_REQUEST,
                field_errors={"password": violation},
            )
        normalized = email.strip().lower()
        existing = await asyncio.to_thread(self._store.find_user_with_credentials, normalized)
        if existing is not None:
            raise AppError(
                ErrorCode.INVALID_REQUEST,
                field_errors={"email": "An account with that email already exists."},
            )
        password_hash = await asyncio.to_thread(hash_password, password)
        try:
            return await asyncio.to_thread(
                self._store.create_user,
                email=normalized,
                name=name.strip(),
                password_hash=password_hash,
                role_ids=role_ids,
            )
        except DuplicateEmailError as exc:
            raise AppError(
                ErrorCode.INVALID_REQUEST,
                field_errors={"email": "An account with that email already exists."},
            ) from exc
        except UnknownRoleError as exc:
            raise _unknown_roles() from exc

    async def update_user(
        self,
        actor: User,
        user_id: str,
        *,
        name: str | None = None,
        role_ids: list[str] | None = None,
        status: UserStatus | None = None,
        password: str | None = None,
    ) -> User:
        """Apply an edit with the guards that protect the admin set."""
        target = await self.get_user(user_id)

        await self._guard_admin_set(actor, target, role_ids=role_ids, status=status)

        password_hash: str | None = None
        if password is not None:
            violation = password_policy_violation(password)
            if violation:
                raise AppError(
                    ErrorCode.INVALID_REQUEST,
                    field_errors={"password": violation},
                )
            password_hash = await asyncio.to_thread(hash_password, password)

        try:
            updated = await asyncio.to_thread(
                self._store.update_user,
                user_id,
                name=name.strip() if name is not None else None,
                role_ids=role_ids,
                status=status,
                password_hash=password_hash,
            )
        except UnknownRoleError as exc:
            raise _unknown_roles() from exc
        except DuplicateEmailError as exc:  # pragma: no cover - email is not editable
            raise AppError(
                ErrorCode.INVALID_REQUEST,
                field_errors={"email": "An account with that email already exists."},
            ) from exc
        if updated is None:  # pragma: no cover - read-then-write race
            raise AppError(ErrorCode.NOT_FOUND, message="That account no longer exists.")

        # A disabled account or a changed password must not keep working
        # somewhere else: existing sessions are the account's live access.
        if (status is not None and status is UserStatus.DISABLED) or password_hash is not None:
            await asyncio.to_thread(self._store.revoke_user_sessions, user_id)
            logger.info("sessions revoked", extra={"user_id": user_id})
        return updated

    async def delete_user(self, actor: User, user_id: str) -> None:
        """Delete an account. Never yourself, never the last administrator."""
        target = await self.get_user(user_id)
        if actor.id == target.id:
            raise AppError(
                ErrorCode.INVALID_STATE_TRANSITION,
                message="You cannot delete your own account.",
            )
        if target.is_admin:
            await self._require_another_active_admin(target)
        await asyncio.to_thread(self._store.delete_user, user_id)
        logger.info("account deleted", extra={"user_id": user_id})

    async def _guard_admin_set(
        self,
        actor: User,
        target: User,
        *,
        role_ids: list[str] | None,
        status: UserStatus | None,
    ) -> None:
        """Refuse edits that would leave the product with no active administrator.

        The rule is the same for self-service and for editing someone else: a
        change that strips admin rights (disabling the account, or moving it off
        every admin role) is allowed only while *another* active administrator
        remains. The two cases get different sentences because they read
        differently to the person clicking save.
        """
        loses_admin = status is UserStatus.DISABLED or (
            role_ids is not None and not await self._prospective_is_admin(role_ids)
        )
        if not loses_admin or not target.is_admin:
            return
        others = await asyncio.to_thread(
            self._store.count_active_admins, excluding_user_id=target.id
        )
        if others > 0:
            return
        if actor.id == target.id:
            raise AppError(
                ErrorCode.FORBIDDEN,
                message="You cannot remove your own administrator access.",
            )
        raise AppError(
            ErrorCode.FORBIDDEN,
            message="At least one active administrator account must remain.",
        )

    async def _prospective_is_admin(self, role_ids: list[str]) -> bool:
        """Whether the proposed role set includes an admin role.

        Consults the role catalogue rather than the target's current roles: a
        user may be *given* an admin role they do not hold yet, and an unknown
        id is left to the store's existence check to reject.
        """
        roles = {role.id: role for role in await asyncio.to_thread(self._store.list_roles)}
        return any(roles[role_id].is_admin for role_id in role_ids if role_id in roles)

    async def _require_another_active_admin(self, target: User) -> None:
        others = await asyncio.to_thread(
            self._store.count_active_admins, excluding_user_id=target.id
        )
        if others == 0:
            raise AppError(
                ErrorCode.FORBIDDEN,
                message="At least one active administrator account must remain.",
            )

    # -- Roles ------------------------------------------------------------

    async def list_roles(self) -> list[Role]:
        return await asyncio.to_thread(self._store.list_roles)

    async def get_role(self, role_id: str) -> Role:
        role = await asyncio.to_thread(self._store.get_role, role_id)
        if role is None:
            raise AppError(ErrorCode.NOT_FOUND, message="That role no longer exists.")
        return role

    async def create_role(
        self, *, name: str, is_admin: bool, permissions: list[VerificationMethod]
    ) -> Role:
        cleaned = name.strip()
        if not cleaned:
            raise AppError(ErrorCode.INVALID_REQUEST, field_errors={"name": "Enter a role name."})
        await self._ensure_role_name_free(cleaned)
        _ensure_permissions_known(permissions)
        try:
            return await asyncio.to_thread(
                self._store.create_role, name=cleaned, is_admin=is_admin, permissions=permissions
            )
        except DuplicateRoleNameError as exc:
            raise _duplicate_role_name() from exc

    async def update_role(
        self,
        role_id: str,
        *,
        name: str | None = None,
        is_admin: bool | None = None,
        permissions: list[VerificationMethod] | None = None,
    ) -> Role:
        role = await self.get_role(role_id)
        cleaned = name.strip() if name is not None else None
        if cleaned is not None:
            if not cleaned:
                raise AppError(
                    ErrorCode.INVALID_REQUEST, field_errors={"name": "Enter a role name."}
                )
            await self._ensure_role_name_free(cleaned, excluding_role_id=role_id)
        if permissions is not None:
            _ensure_permissions_known(permissions)
        if is_admin is not None and is_admin is False and role.is_admin:
            await self._guard_role_demotion(role)

        try:
            updated = await asyncio.to_thread(
                self._store.update_role,
                role_id,
                name=cleaned,
                is_admin=is_admin,
                permissions=permissions,
            )
        except DuplicateRoleNameError as exc:
            raise _duplicate_role_name() from exc
        if updated is None:  # pragma: no cover - read-then-write race
            raise AppError(ErrorCode.NOT_FOUND, message="That role no longer exists.")
        return updated

    async def delete_role(self, role_id: str) -> None:
        """Delete a role, but never one a user still holds."""
        await self.get_role(role_id)
        try:
            await asyncio.to_thread(self._store.delete_role, role_id)
        except RoleInUseError as exc:
            raise AppError(
                ErrorCode.INVALID_STATE_TRANSITION,
                message="That role is still assigned to a user. Reassign them before deleting it.",
            ) from exc

    async def set_role_permissions(
        self, role_id: str, permissions: list[VerificationMethod]
    ) -> Role:
        """Replace a role's permission set — the matrix's assign/reassign/remove."""
        await self.get_role(role_id)
        _ensure_permissions_known(permissions)
        updated = await asyncio.to_thread(self._store.update_role, role_id, permissions=permissions)
        if updated is None:  # pragma: no cover - read-then-write race
            raise AppError(ErrorCode.NOT_FOUND, message="That role no longer exists.")
        return updated

    async def _ensure_role_name_free(
        self, name: str, *, excluding_role_id: str | None = None
    ) -> None:
        existing = await asyncio.to_thread(self._store.find_role_by_name, name)
        if existing is not None and existing.id != excluding_role_id:
            raise _duplicate_role_name()

    async def _guard_role_demotion(self, role: Role) -> None:
        """Refuse removing admin rights from a role no active admin can do without."""
        users = await asyncio.to_thread(self._store.list_users)
        for user in users:
            if not user.is_active:
                continue
            remaining_admin = any(other.is_admin and other.id != role.id for other in user.roles)
            holds_this = any(other.id == role.id for other in user.roles)
            if holds_this and not remaining_admin:
                raise AppError(
                    ErrorCode.FORBIDDEN,
                    message="At least one active administrator account must remain.",
                )

    # -- Permission catalogue ----------------------------------------------

    @staticmethod
    def list_permissions() -> list[tuple[VerificationMethod, str, OfficialApiName]]:
        """(permission key, friendly label, verbatim official name) for all six.

        Derived from the requirement engine, so the admin matrix labels a
        permission with exactly the words the method card shows (§10).
        """
        catalogue = []
        for method in sorted(ALL_PERMISSIONS, key=str):
            requirements = requirements_for(method)
            catalogue.append((method, requirements.user_friendly_label, requirements.official_name))
        return catalogue


# -- Helpers -----------------------------------------------------------------


def _bad_credentials() -> AppError:
    return AppError(
        ErrorCode.UNAUTHENTICATED,
        message="That email or password is incorrect.",
    )


def _duplicate_role_name() -> AppError:
    return AppError(
        ErrorCode.INVALID_REQUEST,
        field_errors={"name": "A role with that name already exists."},
    )


def _unknown_roles() -> AppError:
    return AppError(
        ErrorCode.INVALID_REQUEST,
        field_errors={"roleIds": "One of the selected roles does not exist."},
    )


def _ensure_permissions_known(permissions: list[VerificationMethod]) -> None:
    unknown = set(permissions) - set(ALL_PERMISSIONS)
    if unknown:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            field_errors={"permissions": "That permission does not exist."},
        )


@lru_cache(maxsize=1)
def _dummy_password_hash() -> str:
    """A throwaway hash for the unknown-email path.

    Hashing against it costs the same as a real login, so "no such account"
    and "wrong password" take indistinguishable time.
    """
    return hash_password(secrets.token_urlsafe(16))


# `AuthStoreError` is intentionally *not* caught here: it propagates to the
# global handler, which answers `INTERNAL_ERROR` with the default safe message
# and logs the fault server-side — exactly what a store outage should look like
# (§28).
