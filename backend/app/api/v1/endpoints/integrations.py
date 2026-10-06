"""Third-party integration settings (D19): where results get posted.

Every route sits behind `require_core_post` — the full six-permission set that
Admin and Senior Loan Officer hold — so a Loan Officer gets `403` before any
handler runs, both in the browser and here. The endpoints stay thin: URL,
user and password validation, the blank-password-keeps-the-stored-one rule
and the atomic replace all live in `IntegrationService`.

Routes:

```text
GET  /api/v1/integrations/settings   configured targets (never passwords)
PUT  /api/v1/integrations/settings   replace the whole list
POST /api/v1/integrations/test       probe one system before saving it (D22)
POST /api/v1/integrations/post       send a verification response to them all
```
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import CorePostUserDep, IntegrationServiceDep, require_core_post
from app.infrastructure.integration_store import IntegrationSetting
from app.schemas.integrations import (
    IntegrationSettingInput,
    IntegrationSettingResponse,
    IntegrationSettingsResponse,
    PostFailureResponse,
    PostToCoreRequest,
    PostToCoreResponse,
    SaveIntegrationSettingsRequest,
    TestConnectionResponse,
)

router = APIRouter(
    prefix="/api/v1/integrations",
    tags=["integrations"],
    dependencies=[Depends(require_core_post)],
)


@router.get("/settings", response_model=IntegrationSettingsResponse)
async def list_settings(service: IntegrationServiceDep) -> IntegrationSettingsResponse:
    """Every configured system — URL and API user only, never the password."""
    items = await service.list_settings()
    return IntegrationSettingsResponse(settings=[_setting_response(item) for item in items])


@router.put("/settings", response_model=IntegrationSettingsResponse)
async def save_settings(
    body: SaveIntegrationSettingsRequest,
    service: IntegrationServiceDep,
    _user: CorePostUserDep,
) -> IntegrationSettingsResponse:
    """Replace the complete list of systems to post to (D19)."""
    rows = [
        {
            "id": item.id,
            "url": item.url,
            "apiUser": item.apiUser,
            "apiPassword": item.apiPassword,
        }
        for item in body.settings
    ]
    stored = await service.save_settings(rows)
    return IntegrationSettingsResponse(settings=[_setting_response(item) for item in stored])


def _setting_response(setting: IntegrationSetting) -> IntegrationSettingResponse:
    """The wire shape — deliberately without `api_password` (§29)."""
    return IntegrationSettingResponse(id=setting.id, url=setting.url, apiUser=setting.api_user)


@router.post("/test", response_model=TestConnectionResponse)
async def test_connection(
    body: IntegrationSettingInput,
    service: IntegrationServiceDep,
    _user: CorePostUserDep,
) -> TestConnectionResponse:
    """Probe one system with the values as typed, before anything is saved (D22).

    The row arrives exactly as the dialog holds it: a blank password on an
    existing row uses the stored credential — the same rule a save applies —
    so "Test Connection" answers for the configuration the admin is about to
    keep. The answer is always a `200` describing reachability and auth in
    the post's fixed safe words (§28); only malformed input is an error.
    """
    outcome = await service.test_connection(
        {"id": body.id, "url": body.url, "apiUser": body.apiUser, "apiPassword": body.apiPassword}
    )
    return TestConnectionResponse(**outcome)


@router.post("/post", response_model=PostToCoreResponse)
async def post_to_core(
    body: PostToCoreRequest,
    service: IntegrationServiceDep,
    _user: CorePostUserDep,
) -> PostToCoreResponse:
    """Post the current verification response to every configured system.

    The browser hands over the result exactly as the verifier produced it;
    the service replays it to each target with Basic auth and reports per-url
    outcomes in safe words (§28). `400` when nothing is configured, so the
    click never silently "succeeds" without a target.

    The service records the click in the audit trail (D25) before anything is
    sent and finalises the entry afterwards; the response here maps the failed
    targets onto `PostFailureResponse`, dropping the audit-only detail
    (status codes, driver text, upstream bodies) that §28 keeps off-screen.
    """
    outcome = await service.post_to_core(body.payload, actor=_user)
    return PostToCoreResponse(
        posted=outcome["posted"],
        failed=[
            PostFailureResponse(url=item["url"], reason=item["reason"])
            for item in outcome["failed"]
        ],
    )
