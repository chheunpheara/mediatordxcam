"""Dual-screen onboarding: liveness links, session mint, WebSocket relay (Phase 7).

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
    current_user,
    user_from_websocket,
)
from app.core.config import Settings
from app.core.errors import AppError, ErrorCode
from app.domain.auth import User
from app.infrastructure.liveness_link_store import LivenessLink, LivenessLinkStore
from app.schemas.onboarding import (
    CreateLivenessLinkRequest,
    CreateLivenessLinkResponse,
    LivenessLinkListResponse,
    LivenessLinkOwner,
    LivenessLinkResponse,
    OnboardingSessionCreated,
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
        refusal = None if session_id in _SESSIONS else WS_UNKNOWN_SESSION
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

    Cached on `app.state` exactly like the HTTP provider, so the schema (and
    the retirement of the fixed page's table) happens once per application.
    """
    cached: LivenessLinkStore | None = getattr(websocket.app.state, "liveness_link_store", None)
    if cached is None:
        cached = LivenessLinkStore(websocket.app.state.settings.database_url or "")
        websocket.app.state.liveness_link_store = cached
    return cached
