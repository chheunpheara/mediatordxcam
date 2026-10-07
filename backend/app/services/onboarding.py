"""Onboarding room: per-session registry of WebSocket participants.

Two browser tabs (teller and customer) open the same room by id; incoming
messages are delivered to peers of the *other* role only. Prototype-level:
room membership lives in memory. WebSocket frames arrive as JSON objects with
a `type` field and an arbitrary payload tail.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any, Literal

from fastapi import WebSocket

Role = Literal["teller", "customer"]


class _Room:
    def __init__(self) -> None:
        self.members: dict[Role, set[WebSocket]] = {"teller": set(), "customer": set()}


class OnboardingHub:
    """The join/relay point for dual-screen onboarding sessions."""

    def __init__(self) -> None:
        self._rooms: dict[str, _Room] = {}
        self._lock = asyncio.Lock()

    async def join(self, session_id: str, role: Role, websocket: WebSocket) -> None:
        """Register the socket and hand it the handshake, as one critical step.

        The two have to land together: a peer that can already see this socket
        in the room must be able to talk to it, and a tab that is about to be
        told `peerJoined` must be in the room before that message is collected.
        The endpoint refuses sockets *before* calling this, so a socket is only
        ever accepted here or on its way out with a close code.
        """
        async with self._lock:
            room = self._rooms.setdefault(session_id, _Room())
            # Any number of teller tabs/workspace can watch the same room;
            # each client keeps one socket and leaves independently.
            room.members[role].add(websocket)
            await websocket.accept()

    async def leave(self, session_id: str, role: Role, websocket: WebSocket) -> None:
        async with self._lock:
            room = self._rooms.get(session_id)
            if room is None:
                return
            room.members[role].discard(websocket)
            if not room.members["teller"] and not room.members["customer"]:
                del self._rooms[session_id]

    async def send_to_other_roles(
        self, session_id: str, sender: Role, message: dict[str, Any]
    ) -> int:
        async with self._lock:
            room = self._rooms.get(session_id)
            if room is None:
                return 0
            targets = set()
            for role, sockets in room.members.items():
                # Equality, never identity: `sender` arrives as a parsed query
                # value, which is a different object from the literal above, so
                # `is not` would match the sender's own role too and every
                # message would echo back to the tab that sent it.
                if role != sender:
                    targets.update(sockets)
            target_list = list(targets)
        delivered = 0
        for target in target_list:
            with suppress(Exception):  # a dropped peer rejoins by itself
                await target.send_json(message)
                delivered += 1
        return delivered

    async def broadcast_state_prompt(self, session_id: str, from_role: Role) -> None:
        await self.send_to_other_roles(session_id, from_role, {"type": "peerJoined"})
