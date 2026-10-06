"""Dual-screen onboarding: REST session mint + WebSocket relay (Phase 7).

The teller opens a session, hands `sessionId` to the customer display tab URL,
and both connect through the WebSocket below. The teller sends commands
(`activateLiveness`, `startRecording`, `activateFaceCapture`, `capturePhoto`,
`cancelSession`); the customer streams frames (`frame` with a JPEG data URL),
the still (`photo`) and its other reports back. The relay never inspects a
payload — it delivers to the *other* role in the room.
"""

from __future__ import annotations

import secrets
from typing import cast

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.api.deps import LivenessSettingsDep, current_user, require_admin
from app.infrastructure.liveness_settings_store import LivenessSettingsStore
from app.schemas.onboarding import OnboardingSessionCreated, ShowFixedPage, UpdateFixedPage
from app.services.onboarding import OnboardingHub, Role

router = APIRouter(tags=["onboarding"])

_HUB = OnboardingHub()

# The sessions REST has minted. Kept in memory — a process restart drops
# them, and stale ids answer with close code 4404, which both tabs handle.
_SESSIONS: set[str] = set()


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


@router.get("/api/v1/onboarding/liveness-page", response_model=ShowFixedPage)
async def show_liveness_page(store: LivenessSettingsDep) -> ShowFixedPage:
    settings = store.get()
    return ShowFixedPage(enabled=settings.enabled, sessionId=settings.token)


@router.put(
    "/api/v1/onboarding/liveness-page",
    response_model=ShowFixedPage,
    dependencies=[Depends(require_admin)],
)
async def update_liveness_page(body: UpdateFixedPage, store: LivenessSettingsDep) -> ShowFixedPage:
    settings = store.set_enabled(body.enabled)
    return ShowFixedPage(enabled=settings.enabled, sessionId=settings.token)


@router.websocket("/ws/onboarding/{session_id}")
async def onboarding_ws(websocket: WebSocket, session_id: str, role: Role | None = None) -> None:
    declared_raw = websocket.query_params.get("role") or role or "customer"
    declared = cast(Role, declared_raw if declared_raw in ("teller", "customer") else "customer")
    live_store: LivenessSettingsStore | None = getattr(
        websocket.app.state, "liveness_settings_store", None
    )
    if live_store is None:
        live_store = LivenessSettingsStore(websocket.app.state.settings.database_url or "")
        websocket.app.state.liveness_settings_store = live_store
    settings = live_store.get()
    if session_id not in _SESSIONS and not (settings.enabled and session_id == settings.token):
        await websocket.close(code=4404)
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
