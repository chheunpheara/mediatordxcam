"""The relay's one invariant: other role only (Phase 7 dual-screen).

Incoming messages go to the *other* role and never back to the tab that sent
them. The kind of that comparison matters more than it looks: the sender role is
a parsed query string, not the literal stored as the room's key, so an identity
test matches nothing and every message — frames, the arrival notice, the
activation command — is delivered to its own author as well as to the peer.
"""

from __future__ import annotations

from typing import cast

from app.services.onboarding import OnboardingHub, Role


class _Socket:
    """The two WebSocket methods the hub uses."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def accept(self) -> None:
        pass

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


def _query_role() -> Role:
    """The role as the endpoint actually receives it: parsed, not a literal."""
    return cast(Role, "".join(["cus", "tomer"]))


async def test_a_message_never_echoes_back_to_its_sender() -> None:
    hub = OnboardingHub()
    teller, customer = _Socket(), _Socket()

    await hub.join("sess_1", "teller", teller)  # type: ignore[arg-type]
    await hub.join("sess_1", _query_role(), customer)  # type: ignore[arg-type]

    delivered = await hub.send_to_other_roles("sess_1", _query_role(), {"type": "frame"})

    assert delivered == 1
    assert teller.sent == [{"type": "frame"}]
    assert customer.sent == []


async def test_the_arrival_notice_does_not_reach_the_customer_that_just_joined() -> None:
    hub = OnboardingHub()
    teller, customer = _Socket(), _Socket()

    await hub.join("sess_2", "teller", teller)  # type: ignore[arg-type]
    await hub.join("sess_2", _query_role(), customer)  # type: ignore[arg-type]

    await hub.broadcast_state_prompt("sess_2", _query_role())

    assert teller.sent == [{"type": "peerJoined"}]
    assert customer.sent == []
