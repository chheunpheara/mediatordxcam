"""Dual-screen onboarding: standby screen, liveness links, session mint, WS relay (Phase 7).

Two permanent-ish rooms exist side by side. The **standby screen** is one
global token that never expires: paste its `/display?session=` URL onto the
counter monitor once and it works for any customer who sits down, while the
officer's panel joins it whenever the dialog says "standby". Any officer may
turn it on or off; it never expires and turning it off does not touch a link.

An officer mints one **liveness link** per customer: an unguessable token with
an expiry, handed to the customer monitor as `/display?session=<token>`. Both
tabs then open `/ws/onboarding/<token>` — the teller side has to be the officer
who minted it, the customer side is anonymous — and the relay below carries the
commands and the frames between them.

A second mint supersedes the first, so an officer holds at most one usable URL;
a link that is expired or superseded is refused with a close code both tabs
understand. Nothing ever rewrites a token: a URL already printed on a sticky
note keeps naming the same link until it stops being valid.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from datetime import UTC, datetime
from typing import Literal, cast

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect, status

from app.api.deps import (
    AuthServiceDep,
    CurrentUserDep,
    LivenessLinkDep,
    LivenessSettingsDep,
    current_user,
    user_from_websocket,
)
from app.core.config import Settings
from app.core.errors import AppError, ErrorCode
from app.domain.auth import User
from app.infrastructure.liveness_link_store import LivenessLink, LivenessLinkStore
from app.infrastructure.liveness_settings_store import LivenessSettingsStore
from app.schemas.onboarding import (
    CreateLivenessLinkRequest,
    CreateLivenessLinkResponse,
    LivenessLinkListResponse,
    LivenessLinkOwner,
    LivenessLinkResponse,
    OnboardingSessionCreated,
    ShowFixedPage,
    UpdateFixedPage,
)
from app.services.onboarding import OnboardingHub, Role

router = APIRouter(tags=["onboarding"])

_HUB = OnboardingHub()

# The sessions REST has minted. Kept in memory — a process restart drops
# them, and stale ids answer with close code 4404, which both tabs handle.
_SESSIONS: set[str] = set()

# Close codes the two tabs branch on. They only reach the browser because the
# socket is accepted before it is refused: a close during the handshake arrives
# as an opaque 1006 instead.
WS_TELLER_NOT_OWNER = 4403
WS_UNKNOWN_SESSION = 4404
WS_EXPIRED_LINK = 4410
WS_SUPERSEDED_LINK = 4411
#: The standby token is known, but the officer has the counter screen off.
#: Distinct from 4404: this tab may come back the moment somebody switches on.
WS_DISPLAY_OFF = 4412


@router.get(
    "/api/v1/onboarding/liveness-page",
    response_model=ShowFixedPage,
    summary="Standby-screen room: its permanent token and whether it is in service",
    dependencies=[Depends(current_user)],
)
async def get_liveness_page(store: LivenessSettingsDep) -> ShowFixedPage:
    """One row, created on first read; the token is minted exactly once."""
    page = await asyncio.to_thread(store.get)
    return ShowFixedPage(enabled=page.enabled, sessionId=page.token)


@router.put(
    "/api/v1/onboarding/liveness-page",
    response_model=ShowFixedPage,
    summary="Switch the counter's standby screen on or off",
    dependencies=[Depends(current_user)],
)
async def put_liveness_page(
    body: UpdateFixedPage,
    store: LivenessSettingsDep,
) -> ShowFixedPage:
    """Any officer may do this — it is the counter's screen, not a secret."""
    page = await asyncio.to_thread(store.set_enabled, body.enabled)
    return ShowFixedPage(enabled=page.enabled, sessionId=page.token)


@router.post(
    "/api/v1/onboarding/sessions",
    response_model=OnboardingSessionCreated,
    status_code=201,
    summary="Open a new teller/customer onboarding session",
    dependencies=[Depends(current_user)],
)
async def create_session() -> OnboardingSessionCreated:
    session_id = f"sess_{secrets.token_urlsafe(12)}"
    _SESSIONS.add(session_id)
    return OnboardingSessionCreated(sessionId=session_id)


@router.get(
    "/api/v1/onboarding/liveness-links",
    response_model=LivenessLinkListResponse,
    summary="List liveness links: your own, or every officer's for an administrator",
    dependencies=[Depends(current_user)],
)
async def list_liveness_links(
    user: CurrentUserDep,
    store: LivenessLinkDep,
    service: AuthServiceDep,
    scope: Literal["own", "all"] = Query(
        "own",
        description="`all` is administrator-only and reports every link's metadata.",
    ),
) -> LivenessLinkListResponse:
    """Newest first, expired links included — the officer's own history."""
    if scope == "all":
        if not user.is_admin:
            raise AppError(
                ErrorCode.FORBIDDEN,
                message="You need administrator access to view every link.",
            )
        links = await asyncio.to_thread(store.list_all)
        names = {account.id: account.name for account in await service.list_users()}
    else:
        links = await asyncio.to_thread(store.list_for_owner, user.id)
        names = {user.id: user.name}
    now = time.time()
    return LivenessLinkListResponse(
        links=[_link_response(link, viewer_id=user.id, names=names, now=now) for link in links]
    )


@router.post(
    "/api/v1/onboarding/liveness-links",
    response_model=CreateLivenessLinkResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Mint a liveness link for one customer",
    dependencies=[Depends(current_user)],
)
async def create_liveness_link(
    body: CreateLivenessLinkRequest,
    user: CurrentUserDep,
    store: LivenessLinkDep,
) -> CreateLivenessLinkResponse:
    customer = body.customer.strip()
    if not customer:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            field_errors={"customer": "Enter a label for this customer."},
        )
    link, superseded = await asyncio.to_thread(
        store.create,
        owner_id=user.id,
        customer=customer,
        expires_at=_expiry_from(body),
    )
    return CreateLivenessLinkResponse(
        link=_link_response(
            link,
            viewer_id=user.id,
            names={user.id: user.name},
            now=time.time(),
        ),
        supersededPrevious=superseded,
    )


def _expiry_from(body: CreateLivenessLinkRequest) -> float:
    """The one expiry rule this request carries, as an epoch instant."""
    if body.expiresAt is not None and body.durationSeconds is not None:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            message="Choose an expiry time or a duration, not both.",
            field_errors={"expiresAt": "Choose an expiry time or a duration, not both."},
        )
    if body.durationSeconds is not None:
        return time.time() + body.durationSeconds
    if body.expiresAt is None:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            message="Choose when this link should stop working.",
            field_errors={"expiresAt": "Choose when this link should stop working."},
        )
    expires_at = (
        body.expiresAt if body.expiresAt.tzinfo is not None else body.expiresAt.replace(tzinfo=UTC)
    )
    if expires_at <= datetime.now(UTC):
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            message="Choose an expiry date and time in the future.",
            field_errors={"expiresAt": "Choose an expiry date and time in the future."},
        )
    return expires_at.timestamp()


def _link_response(
    link: LivenessLink, *, viewer_id: str, names: dict[str, str], now: float
) -> LivenessLinkResponse:
    """One row as the wire sees it: `token` only for the officer who minted it."""
    return LivenessLinkResponse(
        id=link.id,
        customer=link.customer,
        token=link.token if link.owner_id == viewer_id else None,
        status=link.status(now),
        createdAt=datetime.fromtimestamp(link.created_at, UTC),
        expiresAt=datetime.fromtimestamp(link.expires_at, UTC),
        supersededAt=(
            datetime.fromtimestamp(link.superseded_at, UTC)
            if link.superseded_at is not None
            else None
        ),
        owner=LivenessLinkOwner(id=link.owner_id, name=names.get(link.owner_id, link.owner_id)),
    )


@router.websocket("/ws/onboarding/{session_id}")
async def onboarding_ws(websocket: WebSocket, session_id: str, role: Role | None = None) -> None:
    declared_raw = websocket.query_params.get("role") or role or "customer"
    declared = cast(Role, declared_raw if declared_raw in ("teller", "customer") else "customer")
    settings: Settings = websocket.app.state.settings
    store = await asyncio.to_thread(_ws_link_store, websocket)
    link = await asyncio.to_thread(store.find_by_token, session_id)
    # Judged before the handshake, so a refusal can accept first and *then*
    # close: only that ordering reaches the browser as these codes rather than
    # as an opaque 1006. A socket that may join is accepted by `join` itself.
    refusal: int | None
    if link is None:
        if session_id in _SESSIONS:
            refusal = None
        else:
            # The standby room: known, global, and open to every teller — the
            # only condition is that somebody has the counter screen in service.
            # `get` mints the row once and then always names the same token.
            standby = await asyncio.to_thread(_ws_settings_store(websocket).get)
            if session_id != standby.token:
                refusal = WS_UNKNOWN_SESSION
            else:
                refusal = None if standby.enabled else WS_DISPLAY_OFF
    else:
        refusal = await _refusal_for(websocket, settings, link, declared)
    if refusal is not None:
        await websocket.accept()
        await websocket.close(code=refusal)
        return
    await _HUB.join(session_id, declared, websocket)
    if declared == "customer":
        # The monitor tab usually opens *after* the teller picked the liveness
        # method, so the activation command was already sent into an empty room.
        # Announce the arrival; the teller panel answers by sending it again.
        await _HUB.broadcast_state_prompt(session_id, declared)
    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except ValueError:
                continue
            if not isinstance(payload, dict) or "type" not in payload:
                continue
            await _HUB.send_to_other_roles(session_id, declared, payload)
    except WebSocketDisconnect:
        pass
    finally:
        # Disconnect or any failure: free the seat either way.
        await _HUB.leave(session_id, declared, websocket)


async def _refusal_for(
    websocket: WebSocket, settings: Settings, link: LivenessLink, declared: Role
) -> int | None:
    """The close code this socket deserves, or `None` when it may join."""
    now = time.time()
    if link.expires_at <= now:
        return WS_EXPIRED_LINK
    if link.superseded_at is not None:
        return WS_SUPERSEDED_LINK
    if declared != "teller":
        return None  # the customer side is anonymous by design
    user: User | None = await user_from_websocket(websocket, settings)
    if user is None or user.id != link.owner_id:
        return WS_TELLER_NOT_OWNER
    return None


def _ws_link_store(websocket: WebSocket) -> LivenessLinkStore:
    """The link store behind a WebSocket: a socket has an app, not a request.

    Cached on `app.state` exactly like the HTTP provider, so the schema
    happens once per application.
    """
    cached: LivenessLinkStore | None = getattr(websocket.app.state, "liveness_link_store", None)
    if cached is None:
        cached = LivenessLinkStore(websocket.app.state.settings.database_url or "")
        websocket.app.state.liveness_link_store = cached
    return cached


def _ws_settings_store(websocket: WebSocket) -> LivenessSettingsStore:
    """The standby-screen store behind a WebSocket, cached like its HTTP twin."""
    cached: LivenessSettingsStore | None = getattr(
        websocket.app.state, "liveness_settings_store", None
    )
    if cached is None:
        cached = LivenessSettingsStore(websocket.app.state.settings.database_url or "")
        websocket.app.state.liveness_settings_store = cached
    return cached
