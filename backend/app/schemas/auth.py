"""Schemas for sign-in and account administration (D18).

Field names are camelCase like every other transport model — `roleIds`,
`isAdmin` — so the admin forms post exactly what they display. Passwords appear
in requests only, never in responses: `UserResponse` carries roles and status,
and the password hash never leaves the store (§30).

`token` in `LoginResponse` exists for non-browser clients (curl, tests) that
cannot keep an `HttpOnly` cookie jar; the SPA reads the cookie instead, which
is why the browser code never touches it.
"""

from __future__ import annotations

from pydantic import Field

from app.domain.auth import UserStatus
from app.domain.enums import OfficialApiName, VerificationMethod
from app.schemas.common import ApiModel


class LoginRequest(ApiModel):
    """`POST /api/v1/auth/login` input."""

    email: str = Field(min_length=3, max_length=254, description="Account email.")
    #: Length deliberately uncapped here: a wrong password must answer "that
    #  email or password is incorrect", not a validation complaint about length.
    password: str = Field(min_length=1, description="Plaintext password; never logged (§29).")


class RoleSummaryResponse(ApiModel):
    """The role reference embedded in a user."""

    id: str
    name: str


class UserResponse(ApiModel):
    """One account. Passwords and hashes are absent by construction."""

    id: str
    email: str
    name: str
    status: UserStatus
    roles: list[RoleSummaryResponse]
    isAdmin: bool = Field(description="True when any held role carries admin rights.")


class LoginResponse(ApiModel):
    """Session started: the bearer token and the account it belongs to."""

    token: str = Field(description="Opaque session token, for non-browser clients.")
    user: UserResponse


class CreateUserRequest(ApiModel):
    """`POST /api/v1/admin/users` input."""

    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(
        min_length=1, max_length=128, description="Checked against the password policy."
    )
    roleIds: list[str] = Field(default_factory=list, max_length=20)


class UpdateUserRequest(ApiModel):
    """`PATCH /api/v1/admin/users/{id}` input. Omitted fields stay unchanged."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    roleIds: list[str] | None = Field(default=None, max_length=20)
    status: UserStatus | None = None
    password: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        description="Replace the password; omitted keeps the current one.",
    )


class RoleResponse(ApiModel):
    """One role with its permission keys (the six method ids)."""

    id: str
    name: str
    isAdmin: bool
    permissions: list[VerificationMethod]


class CreateRoleRequest(ApiModel):
    """`POST /api/v1/admin/roles` input."""

    name: str = Field(min_length=1, max_length=80)
    isAdmin: bool = False
    permissions: list[VerificationMethod] = Field(default_factory=list)


class UpdateRoleRequest(ApiModel):
    """`PATCH /api/v1/admin/roles/{id}` input. Omitted fields stay unchanged."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    isAdmin: bool | None = None


class SetRolePermissionsRequest(ApiModel):
    """`PUT /api/v1/admin/roles/{id}/permissions` input — the full new set."""

    permissions: list[VerificationMethod]


class PermissionItemResponse(ApiModel):
    """One assignable permission: the key plus how to label it in the matrix."""

    key: VerificationMethod
    label: str = Field(description="Same friendly label the method card shows (§10).")
    officialName: OfficialApiName


class UserListResponse(ApiModel):
    users: list[UserResponse]


class RoleListResponse(ApiModel):
    roles: list[RoleResponse]


class PermissionListResponse(ApiModel):
    permissions: list[PermissionItemResponse]
