"""Onboarding session and liveness-link wire models (Phase 7)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

#: Longest link a link may live: 30 days. Presets stop at a week; this is the
#: ceiling the API refuses past, so a typo cannot park a URL open for a year.
MAX_LINK_TTL_SECONDS = 60 * 60 * 24 * 30

#: Derived, not stored: `expired` outranks `superseded`, which outranks a link
#: that is simply ready for the customer monitor.
LinkStatus = Literal["in_use", "superseded", "expired"]


class OnboardingSessionCreated(BaseModel):
    """Teller created a new room; open the customer URL on the secondary display."""

    sessionId: str = Field(description="Unguessable room id for the WS pair")


class VerifyLivenessResponse(BaseModel):
    """Accepted and stored artefact handle for the customer's recorded video."""

    livenessRef: str = Field(description="Opaque handle for the stored webm/mp4")


class ShowFixedPage(BaseModel):
    """Standby-screen settings: the one permanent room for the counter monitor."""

    enabled: bool
    #: Stable token that never rotates, so the URL pasted on the standby
    #: monitor survives redeploys, reloads and every toggle.
    sessionId: str


class UpdateFixedPage(BaseModel):
    enabled: bool


class LivenessLinkOwner(BaseModel):
    """The officer who minted a link — how the administrator view tells links apart."""

    id: str
    name: str


class LivenessLinkResponse(BaseModel):
    """One link as the API reports it.

    `token` is the secret in `?session=`: shown only to the officer who minted
    it, so an administrator reviewing activity cannot read somebody else's
    customer-display URL.
    """

    id: str
    customer: str = Field(description="Free-text label for the customer this link is for.")
    token: str | None = Field(description="Secret room token; null for links you do not own.")
    status: LinkStatus
    createdAt: datetime
    expiresAt: datetime
    supersededAt: datetime | None
    owner: LivenessLinkOwner


class LivenessLinkListResponse(BaseModel):
    links: list[LivenessLinkResponse]


class CreateLivenessLinkRequest(BaseModel):
    """Mint one link: a customer label plus exactly one way to end it."""

    customer: str = Field(min_length=1, max_length=120)
    durationSeconds: int | None = Field(
        default=None,
        ge=1,
        le=MAX_LINK_TTL_SECONDS,
        description="Lifetime from now, e.g. 3600 for an hour.",
    )
    expiresAt: datetime | None = Field(
        default=None,
        description="Explicit expiry instant; a past time is refused.",
    )


class CreateLivenessLinkResponse(BaseModel):
    link: LivenessLinkResponse
    supersededPrevious: bool = Field(
        description="True when an already-handed-out link stopped working because of this one."
    )
