"""Account administration: users, roles and the permission matrix (D18).

Every route sits behind `require_admin`, so a non-admin gets `403` before any
handler runs — there is no 404-vs-403 distinction to probe here. The endpoints
stay thin: validation, guards (last-admin protection, self-deletion, role
reuse) and the password policy all live in `AuthService`, which is where they
are tested.

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
```
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.deps import AdminUserDep, AuthServiceDep, require_admin
from app.api.v1.endpoints.auth import _user_response
from app.domain.auth import Role
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


def _role_response(role: Role) -> RoleResponse:
    """Map a domain role onto the wire shape."""
    return RoleResponse(
        id=role.id,
        name=role.name,
        isAdmin=role.is_admin,
        permissions=sorted(role.permissions, key=str),
    )
