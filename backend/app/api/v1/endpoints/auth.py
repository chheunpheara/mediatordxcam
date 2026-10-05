"""Sign-in, sign-out and the current session (D18).

`POST /login` starts a session: credentials are verified by `AuthService` and
the opaque token is returned both as an `HttpOnly` cookie (what the browser
uses — script cannot read it, so XSS cannot exfiltrate it) and in the body
(for curl and tests, which keep no cookie jar).

The login route is the only one under `/api/v1/auth` without a guard, by
definition. `/me` sits behind `current_user`, so it answers `401` when nobody
is signed in and the development user while `AUTH_ENABLED=false`.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from app.api.deps import (
    SESSION_COOKIE,
    AuthServiceDep,
    CurrentUserDep,
    SettingsDep,
    extract_session_token,
)
from app.domain.auth import User
from app.schemas.auth import LoginRequest, LoginResponse, RoleSummaryResponse, UserResponse
from app.schemas.common import error_responses
from app.services.auth import SESSION_TTL_SECONDS

router = APIRouter(tags=["auth"])


@router.post(
    "/api/v1/auth/login",
    response_model=LoginResponse,
    summary="Sign in with email and password",
    responses=error_responses(status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
)
async def login(
    body: LoginRequest,
    response: Response,
    service: AuthServiceDep,
    settings: SettingsDep,
) -> LoginResponse:
    """Start a session for a valid, active account (D18).

    Wrong email and wrong password share one `401` message, so the form cannot
    be used to discover which addresses have accounts. A disabled account is
    told as much — its holder already knows the address exists.
    """
    user, token = await service.login(body.email, body.password)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_TTL_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
        # `Secure` only in production: a local http://localhost stack must still
        # receive the cookie, and `app_env` is pinned to `docker` in compose.
        secure=settings.is_production,
    )
    return LoginResponse(token=token, user=_user_response(user))


@router.post(
    "/api/v1/auth/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="End the current session",
)
async def logout(
    request: Request,
    response: Response,
    service: AuthServiceDep,
    settings: SettingsDep,
) -> Response:
    """Revoke the presented session and clear its cookie (idempotent; D18).

    No `current_user` dependency on purpose: signing out when already signed
    out must still succeed, and an expired token has nothing left to revoke.
    """
    token = extract_session_token(request)
    if token is not None:
        await service.logout(token)
    response.status_code = status.HTTP_204_NO_CONTENT
    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.is_production,
    )
    return response


@router.get(
    "/api/v1/auth/me",
    response_model=UserResponse,
    summary="The signed-in account",
    responses=error_responses(status.HTTP_401_UNAUTHORIZED),
)
async def me(user: CurrentUserDep) -> UserResponse:
    """Return the account behind the presented session (D18)."""
    return _user_response(user)


def _user_response(user: User) -> UserResponse:
    """Map a domain user onto the wire shape (no hash, no internals)."""
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        status=user.status,
        roles=[RoleSummaryResponse(id=role.id, name=role.name) for role in user.roles],
        isAdmin=user.is_admin,
    )
