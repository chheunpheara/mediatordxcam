"""Schemas for third-party posting settings (D19).

camelCase field names like every other transport model. The password is
accepted in requests but never appears in a response — `GET /settings` returns
URL and API user only, and a save that sends a blank password for an existing
row keeps the stored one.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from app.schemas.common import ApiModel


class IntegrationSettingResponse(ApiModel):
    """One configured target, without its password (D19)."""

    id: str
    url: str
    apiUser: str


class IntegrationSettingInput(ApiModel):
    """One row of the save form. `id` present = update, absent = new."""

    id: str | None = None
    url: str = Field(max_length=2048)
    apiUser: str = Field(max_length=255)
    apiPassword: str | None = Field(default=None, max_length=512)


class SaveIntegrationSettingsRequest(ApiModel):
    """`PUT /api/v1/integrations/settings` — the complete list, replaced."""

    settings: list[IntegrationSettingInput] = Field(max_length=50)


class IntegrationSettingsResponse(ApiModel):
    settings: list[IntegrationSettingResponse]


class PostToCoreRequest(ApiModel):
    """`POST /api/v1/integrations/post` — the verification response to send."""

    payload: dict[str, Any]


class PostFailureResponse(ApiModel):
    """One target that did not accept the post, in safe words only (§28)."""

    url: str
    reason: str


class PostToCoreResponse(ApiModel):
    """Outcome per target: which systems took it, which did not."""

    posted: list[str]
    failed: list[PostFailureResponse]


class TestConnectionResponse(ApiModel):
    """`POST /api/v1/integrations/test` — probe one draft row (D22).

    `reason` is `None` on success and one of the fixed safe sentences
    otherwise (§28) — the same words the post reports, never upstream text.
    """

    ok: bool
    reason: str | None = None
