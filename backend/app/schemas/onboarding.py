"""Onboarding session and liveness-upload wire models (Phase 7)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class OnboardingSessionCreated(BaseModel):
    """Teller created a new room; open the customer URL on the secondary display."""

    sessionId: str = Field(description="Unguessable room id for the WS pair")


class VerifyLivenessResponse(BaseModel):
    """Accepted and stored artefact handle for the customer's recorded video."""

    livenessRef: str = Field(description="Opaque handle for the stored webm/mp4")


class ShowFixedPage(BaseModel):
    """Admin-fixed URL settings for the customer display."""

    enabled: bool
    #: Stable token that never rotates; admin URL persists across reloads.
    sessionId: str


class UpdateFixedPage(BaseModel):
    enabled: bool
