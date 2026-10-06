"""Schemas for the audit trail reporting API (D25).

Read-only transport models for `GET /api/v1/admin/audit-logs`: one entry per
manual action, plus the same `{logs, total}` envelope the records list uses.
camelCase like every other wire model; `createdAt` and `completedAt` are UTC
epoch seconds, matching `RecordResponse.createdAt`.

The status vocabulary is uppercase (`PENDING`, `SUCCESS`, `FAILED`) because
the log is read as evidence, where the exact word the requirement named is
more useful than a house-style restyling of it. `biometricConfidenceScore`
is nullable by contract: this build records no liveness or face-match
percentage (§24), so the column ships honest `NULL`s rather than a number
borrowed from somewhere else.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from app.schemas.common import ApiModel

#: The manual actions the gateway records; see `infrastructure/audit_store`.
AuditActionType = Literal["CAMDX_FETCH", "IDENTITY_VERIFIED", "MANUAL_APPROVED", "POST_TO_CORE"]

#: Row lifecycle: `PENDING` only exists between the click and the answer.
AuditLogStatus = Literal["PENDING", "SUCCESS", "FAILED"]


class AuditLogResponse(ApiModel):
    """One audit entry: immutable facts plus its single outcome transition."""

    id: str
    createdAt: float = Field(description="UTC epoch seconds of the action.")
    staffId: str = Field(description="The authenticated staff member's SSO id.")
    staffEmail: str
    staffRole: str = Field(description="Comma-separated SSO role names at the time.")
    actionType: AuditActionType
    targetSystemUrl: str | None = Field(
        default=None,
        description="Where the post went; several systems are comma-separated.",
    )
    payloadSnapshot: dict[str, object] = Field(
        description="The transmitted data, masked before storage (§29)."
    )
    biometricConfidenceScore: float | None = Field(
        default=None,
        description="Liveness/face-match percentage; NULL when the build has none (§24).",
    )
    status: AuditLogStatus
    errorResponse: str | None = Field(
        default=None,
        description="The target system's error response, or the refusal reason.",
    )
    completedAt: float | None = None


class AuditLogListResponse(ApiModel):
    """One page of audit entries plus how many the filter matched in total."""

    logs: list[AuditLogResponse]
    total: int
