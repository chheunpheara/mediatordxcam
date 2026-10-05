"""Accounts, roles and the permission model (D18).

Pure types and rules — no I/O, no FastAPI, no settings (§3 of `domain/enums.py`
applies here too). A permission *is* a `VerificationMethod`: the six CamDigiKey
APIs are the entire scope vocabulary, so there is no second list to drift, and
`len(ALL_PERMISSIONS) == 6` holds by construction.

Multiple roles per user are modelled as a tuple; a user's effective permission
set is the union of their roles' permissions, and `is_admin` is true when *any*
held role is an admin role.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from app.domain.enums import VerificationMethod

#: Every permission the system recognises — the six CamDigiKey KYC APIs (§2).
ALL_PERMISSIONS: frozenset[VerificationMethod] = frozenset(VerificationMethod)


class UserStatus(StrEnum):
    """Whether an account may sign in (D18)."""

    ACTIVE = "active"
    DISABLED = "disabled"


@dataclass(frozen=True)
class Role:
    """A named bundle of permissions, optionally carrying admin rights."""

    id: str
    name: str
    is_admin: bool
    permissions: frozenset[VerificationMethod]


@dataclass(frozen=True)
class User:
    """One account with the roles it holds.

    `is_admin` and `permissions` are derived, never stored twice: they are the
    union over `roles`, so a role edit takes effect for every holder at once.
    """

    id: str
    email: str
    name: str
    status: UserStatus
    roles: tuple[Role, ...]

    @property
    def is_admin(self) -> bool:
        return any(role.is_admin for role in self.roles)

    @property
    def permissions(self) -> frozenset[VerificationMethod]:
        if not self.roles:
            return frozenset()
        return frozenset().union(*(role.permissions for role in self.roles))

    @property
    def is_active(self) -> bool:
        return self.status is UserStatus.ACTIVE


# -- Password policy (requirement: strong passwords) -------------------------
#
# Eight characters with all four classes: long enough to matter, short enough
# that a person can still remember one, and strict enough to reject the obvious
# choices. `P4ssw0rd!` — the documented default admin password — satisfies it,
# which is deliberate: the policy must not lock out the account the product
# boots with.

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

#: The single sentence shown when a password fails the policy. One message for
#: every rule keeps the copy stable no matter which rule was tripped first.
# The wording is rule text shown to users, not a credential (`S105` is about
# secrets in code — this sentence is deliberately public).
PASSWORD_POLICY_MESSAGE = (
    "Password must be at least 8 characters and include an upper-case letter, "  # noqa: S105
    "a lower-case letter, a number and a symbol."
)


def password_policy_violation(password: str) -> str | None:
    """Return the user-facing reason a password is unacceptable, or `None`.

    Pure and dependency-free so the same rule can run in the endpoint, the
    admin form, and a unit test without a single mock.
    """
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
    if len(password) < MIN_PASSWORD_LENGTH:
        return PASSWORD_POLICY_MESSAGE
    if not any(char.isupper() for char in password):
        return PASSWORD_POLICY_MESSAGE
    if not any(char.islower() for char in password):
        return PASSWORD_POLICY_MESSAGE
    if not any(char.isdigit() for char in password):
        return PASSWORD_POLICY_MESSAGE
    if all(char.isalnum() for char in password):
        return PASSWORD_POLICY_MESSAGE
    return None
