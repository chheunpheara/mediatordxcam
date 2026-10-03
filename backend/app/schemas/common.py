"""Shared transport schemas.

These are presentation contracts only. Domain objects are converted at the
service boundary, so nothing from a CamDX payload and nothing from OpenCV ever
reaches a response body unchanged (§23, §28).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    """Base for request/response models.

    `extra="forbid"` makes an unrecognised field a 400 rather than something
    silently ignored — which matters most for `verify`, where an unexpected field
    could mean the frontend and backend disagree about the contract.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ErrorBody(ApiModel):
    """The user-facing part of a failure (§28).

    `requestId` is the only diagnostic exposed. No upstream code, endpoint,
    status line or internal score appears in this model.
    """

    code: str = Field(description="Stable business code for programmatic branching.")
    message: str = Field(description="Safe, user-facing sentence.")
    fieldErrors: dict[str, str] = Field(
        default_factory=dict, description="Per-field messages for inline display."
    )
    requestId: str = Field(description="Correlation id for support.")
    missing: list[str] | None = Field(
        default=None,
        description="Unsatisfied requirement flags, present on REQUIREMENTS_NOT_MET.",
    )
    detail: str | None = Field(
        default=None,
        description="Development-only detail. Omitted unless explicitly enabled.",
    )


class ErrorResponse(ApiModel):
    """Envelope returned for every failure."""

    error: ErrorBody


class HealthResponse(ApiModel):
    """Readiness payload for `GET /api/v1/health`.

    Intended for developers and operators; never rendered in the verification UI
    (§24). Exposes configuration facts, never credentials.
    """

    status: str = Field(description="'ok' or 'degraded'.")
    service: str
    version: str
    environment: str
    camdxMode: str = Field(description="'mock' or 'real' (§21).")
    time: str = Field(description="ISO-8601 server time.")


class LiveResponse(ApiModel):
    """Minimal liveness payload for `GET /health`."""

    status: str


def error_responses(*codes: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses` entries for the documented failure statuses."""
    return {code: {"model": ErrorResponse} for code in codes}
