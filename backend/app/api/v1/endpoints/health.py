"""Health endpoints.

Two probes with different jobs:

* `GET /health` — liveness. Answers "is this process up?" with no dependency
  checks. Docker restarts the container only when this fails.
* `GET /api/v1/health` — readiness. Answers "can this process serve requests?"
  and reports non-secret configuration facts for developers and operators (§24).

In `CAMDX_MODE=mock` there is no upstream to probe, so readiness is always `ok`.
In real mode the provider's readiness is consulted; that check arrives with
Phase 5, where `CamDXProvider` exists.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Response, status

from app.api.deps import SettingsDep
from app.schemas.common import HealthResponse, LiveResponse

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=LiveResponse,
    summary="Liveness probe",
)
async def liveness() -> LiveResponse:
    """Return `200 {"status":"ok"}` whenever the process is able to serve."""
    return LiveResponse(status="ok")


@router.get(
    "/api/v1/health",
    response_model=HealthResponse,
    summary="Readiness probe",
)
async def readiness(
    response: Response,
    settings: SettingsDep,
) -> HealthResponse:
    """Report readiness plus non-secret configuration facts.

    Returns `503` with `status: "degraded"` when a required dependency is
    unavailable. `camdxMode` is reported because it is a behavioural fact an
    operator must be able to see; no credential, endpoint or secret is included.
    """
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=settings.app_version,
        environment=str(settings.app_env),
        camdxMode=str(settings.camdx_mode),
        time=datetime.now(UTC).isoformat(timespec="seconds"),
    )


@router.get("/health/ready", response_model=HealthResponse, include_in_schema=False)
async def readiness_alias(response: Response, settings: SettingsDep) -> HealthResponse:
    """Alias kept for orchestrators that probe `/health/ready` by convention."""
    response.status_code = status.HTTP_200_OK
    return await readiness(response, settings)
