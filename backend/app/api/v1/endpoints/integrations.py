"""Third-party integration settings (D19): where results get posted.

Every route sits behind `require_core_post` — the full six-permission set that
Admin and Senior Loan Officer hold — so a Loan Officer gets `403` before any
handler runs, both in the browser and here. The endpoints stay thin: URL,
user and password validation, the blank-password-keeps-the-stored-one rule
and the atomic replace all live in `IntegrationService`.

Routes:

```text
GET /api/v1/integrations/settings   configured targets (never passwords)
PUT /api/v1/integrations/settings   replace the whole list
```
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import CorePostUserDep, IntegrationServiceDep, require_core_post
from app.infrastructure.integration_store import IntegrationSetting
from app.schemas.integrations import (
    IntegrationSettingResponse,
    IntegrationSettingsResponse,
    SaveIntegrationSettingsRequest,
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
