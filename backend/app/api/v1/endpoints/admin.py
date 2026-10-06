"""Account administration: users, roles, the permission matrix and the audit trail (D18, D25).

Every route sits behind `require_admin`, so a non-admin gets `403` before any
handler runs — there is no 404-vs-403 distinction to probe here. The endpoints
stay thin: validation, guards (last-admin protection, self-deletion, role
reuse) and the password policy all live in `AuthService`, which is where they
are tested; the audit trail is read-only here and written only by the actions
themselves (D25).

Routes:

```text
GET    /api/v1/admin/permissions                the six assignable permissions
GET    /api/v1/admin/users                      all accounts
POST   /api/v1/admin/users                      create one
PATCH  /api/v1/admin/users/{user_id}            edit name/roles/status/password
DELETE /api/v1/admin/users/{user_id}            delete one
GET    /api/v1/admin/roles                      all roles with permissions
POST   /api/v1/admin/roles                      create one
PATCH  /api/v1/admin/roles/{role_id}            rename / toggle admin rights
PUT    /api/v1/admin/roles/{role_id}/permissions  replace the permission set
DELETE /api/v1/admin/roles/{role_id}            delete one
GET    /api/v1/admin/audit-logs                 read-only audit trail (D25)
```
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import AdminUserDep, AuditServiceDep, AuthServiceDep, require_admin
from app.api.v1.endpoints.auth import _user_response
from app.core.errors import AppError, ErrorCode
from app.domain.auth import Role
from app.infrastructure.audit_store import AuditLogEntry
from app.schemas.audit import (
    AuditActionType,
    AuditLogListResponse,
    AuditLogResponse,
    AuditLogStatus,
)
from app.schemas.auth import (
    CreateRoleRequest,
    CreateUserRequest,
    PermissionItemResponse,
    PermissionListResponse,
    RoleListResponse,
    RoleResponse,
    SetRolePermissionsRequest,
    UpdateRoleRequest,
    UpdateUserRequest,
    UserListResponse,
    UserResponse,
)
from app.services.auth import AuthService

router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


@router.get("/permissions", response_model=PermissionListResponse)
async def list_permissions() -> PermissionListResponse:
    """The six assignable permissions, labelled as the method cards label them."""
    items = [
        PermissionItemResponse(key=key, label=label, officialName=official)
        for key, label, official in AuthService.list_permissions()
    ]
    return PermissionListResponse(permissions=items)


@router.get("/users", response_model=UserListResponse)
async def list_users(service: AuthServiceDep) -> UserListResponse:
    """Every account with its roles and status."""
    return UserListResponse(users=[_user_response(user) for user in await service.list_users()])


@router.post(
    "/users",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an account",
)
async def create_user(body: CreateUserRequest, service: AuthServiceDep) -> UserResponse:
    """Create an account with roles and a policy-compliant password (D18)."""
    user = await service.create_user(
        email=body.email,
        name=body.name,
        password=body.password,
        role_ids=body.roleIds,
    )
    return _user_response(user)


@router.patch("/users/{user_id}", response_model=UserResponse, summary="Edit an account")
async def update_user(
    body: UpdateUserRequest,
    user_id: str,
    actor: AdminUserDep,
    service: AuthServiceDep,
) -> UserResponse:
    """Change name, roles, status or password. Omitted fields stay unchanged."""
    user = await service.update_user(
        actor,
        user_id,
        name=body.name,
        role_ids=body.roleIds,
        status=body.status,
        password=body.password,
    )
    return _user_response(user)


@router.delete(
    "/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an account",
)
async def delete_user(user_id: str, actor: AdminUserDep, service: AuthServiceDep) -> None:
    """Delete an account (never yourself, never the last admin; D18)."""
    await service.delete_user(actor, user_id)


@router.get("/roles", response_model=RoleListResponse)
async def list_roles(service: AuthServiceDep) -> RoleListResponse:
    """Every role with its permission keys — what the matrix renders."""
    return RoleListResponse(roles=[_role_response(role) for role in await service.list_roles()])


@router.post(
    "/roles",
    response_model=RoleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a role",
)
async def create_role(body: CreateRoleRequest, service: AuthServiceDep) -> RoleResponse:
    """Create a role with an initial permission set."""
    role = await service.create_role(
        name=body.name, is_admin=body.isAdmin, permissions=body.permissions
    )
    return _role_response(role)


@router.patch("/roles/{role_id}", response_model=RoleResponse, summary="Edit a role")
async def update_role(
    body: UpdateRoleRequest, role_id: str, service: AuthServiceDep
) -> RoleResponse:
    """Rename a role or grant/remove its admin rights."""
    role = await service.update_role(
        role_id, name=body.name, is_admin=body.isAdmin, permissions=None
    )
    return _role_response(role)


@router.put(
    "/roles/{role_id}/permissions",
    response_model=RoleResponse,
    summary="Replace a role's permissions",
)
async def set_role_permissions(
    body: SetRolePermissionsRequest, role_id: str, service: AuthServiceDep
) -> RoleResponse:
    """Assign, reassign or remove permissions — the matrix's save operation."""
    role = await service.set_role_permissions(role_id, body.permissions)
    return _role_response(role)


@router.delete(
    "/roles/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a role",
)
async def delete_role(role_id: str, service: AuthServiceDep) -> None:
    """Delete a role that no user still holds."""
    await service.delete_role(role_id)


#: Audit-list query parameters (D25), same shape as the records list.
AuditStaffIdParam = Annotated[str | None, Query(alias="staffId", max_length=64)]
AuditActionParam = Annotated[AuditActionType | None, Query(alias="actionType")]
AuditStatusParam = Annotated[AuditLogStatus | None, Query(alias="status")]
AuditDateFromParam = Annotated[str | None, Query(alias="dateFrom", max_length=40)]
AuditDateToParam = Annotated[str | None, Query(alias="dateTo", max_length=40)]
AuditLimitParam = Annotated[int, Query(ge=1, le=100, description="Page size.")]
AuditOffsetParam = Annotated[int, Query(ge=0, description="Rows to skip.")]


@router.get("/audit-logs", response_model=AuditLogListResponse, summary="Read the audit trail")
async def list_audit_logs(
    audit: AuditServiceDep,
    staff_id: AuditStaffIdParam = None,
    action_type: AuditActionParam = None,
    log_status: AuditStatusParam = None,
    date_from: AuditDateFromParam = None,
    date_to: AuditDateToParam = None,
    limit: AuditLimitParam = 25,
    offset: AuditOffsetParam = 0,
) -> AuditLogListResponse:
    """One page of audit entries, newest first, plus the matched total (D25).

    Read-only by construction: this router has no write route to the audit
    trail, the store has no update or delete beyond the single guarded
    finalisation, and the database triggers refuse everything else (D25).
    Filters combine: `staffId`, `actionType`, `status` and a `dateFrom` /
    `dateTo` range, the last accepting `YYYY-MM-DD` (a whole day) or an ISO
    8601 timestamp, all interpreted as UTC like the rows themselves.
    """
    start, end = _date_bounds(date_from, date_to)
    logs, total = await audit.list_logs(
        staff_id=staff_id,
        action_type=action_type,
        status=log_status,
        date_from=start,
        date_to=end,
        limit=limit,
        offset=offset,
    )
    return AuditLogListResponse(logs=[_audit_log_response(entry) for entry in logs], total=total)


def _audit_log_response(entry: AuditLogEntry) -> AuditLogResponse:
    """Map a stored entry onto the wire shape; the snapshot is already masked."""
    return AuditLogResponse(
        id=entry.id,
        createdAt=entry.created_at,
        staffId=entry.staff_id,
        staffEmail=entry.staff_email,
        staffRole=entry.staff_role,
        actionType=entry.action_type,
        targetSystemUrl=entry.target_system_url,
        payloadSnapshot=entry.payload,
        biometricConfidenceScore=entry.biometric_confidence_score,
        status=entry.status,
        errorResponse=entry.error_response,
        completedAt=entry.completed_at,
    )


def _date_bounds(date_from: str | None, date_to: str | None) -> tuple[float | None, float | None]:
    """Parse the two filter dates to UTC epoch bounds, inclusive at both ends."""
    start = _parse_bound(date_from, field="dateFrom", end_of_day=False)
    end = _parse_bound(date_to, field="dateTo", end_of_day=True)
    if start is not None and end is not None and start > end:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            message="The start date must be on or before the end date.",
            field_errors={"dateFrom": "The start date must be on or before the end date."},
        )
    return start, end


def _parse_bound(value: str | None, *, field: str, end_of_day: bool) -> float | None:
    """One filter date to epoch seconds; a bare date covers its whole day."""
    if value is None:
        return None
    message = "Enter a date as YYYY-MM-DD or an ISO 8601 timestamp."
    stripped = value.strip()
    try:
        moment = datetime.fromisoformat(stripped)
    except ValueError:
        raise AppError(
            ErrorCode.INVALID_REQUEST, message=message, field_errors={field: message}
        ) from None
    if len(stripped) == 10 and end_of_day:
        moment = moment + timedelta(days=1) - timedelta(milliseconds=1)
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC).timestamp()
    return moment.astimezone(UTC).timestamp()


def _role_response(role: Role) -> RoleResponse:
    """Map a domain role onto the wire shape."""
    return RoleResponse(
        id=role.id,
        name=role.name,
        isAdmin=role.is_admin,
        permissions=sorted(role.permissions, key=str),
    )
