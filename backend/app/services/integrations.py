"""Third-party posting settings and the post itself (D19).

The application layer over `infrastructure/integration_store`: it owns the
validation the endpoints rely on (a usable URL, a named API user, a password
for anything new) and later the outbound post. Passwords are accepted here,
stored by the store, and deliberately never returned — a save that presents a
blank password for a row that already exists keeps the stored one, so the form
never needs to read a secret back to let an admin edit a URL.

Every blocking call runs in a worker thread (`asyncio.to_thread`), matching
the account service: a database round-trip must not stall the event loop.
"""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import Settings
from app.core.errors import AppError, ErrorCode
from app.infrastructure.integration_store import (
    IntegrationSetting,
    IntegrationStore,
    new_setting_id,
    resolve_integration_database_url,
)

#: Outbound post timeout. Deliberately a module constant, not a Settings
#: field: one number, no compose/env surface for a value no operator asked for.
POST_TIMEOUT_SECONDS = 10.0

#: Failure words an end user may read. Safe for §28: no URLs, credentials,
#: stack text or upstream body ever reaches the screen.
REASON_TIMEOUT = "The system timed out."
REASON_UNREACHABLE = "The system could not be reached."
REASON_CREDENTIALS = "The system refused the API credentials."
REASON_REJECTED = "The system did not accept the submission."
NO_SETTINGS_MESSAGE = "There are no core systems configured yet. Add one in Post Settings first."


class IntegrationService:
    """Settings CRUD and the outbound post for core-systems (D19)."""

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._store = IntegrationStore(resolve_integration_database_url(settings.database_url))
        #: Injected in tests (`httpx.MockTransport`); production sends over
        #: the real network with the default transport.
        self._transport = transport

    async def list_settings(self) -> list[IntegrationSetting]:
        """Every target including passwords — callers decide what may leave."""
        return await asyncio.to_thread(self._store.list_settings)

    async def save_settings(self, rows: list[dict[str, str | None]]) -> list[IntegrationSetting]:
        """Validate and replace the whole list; returns what was stored.

        Each row is `{id, url, apiUser, apiPassword}` — `id` present means the
        row already exists (its blank password keeps the stored one), absent
        means new (its password is required). One `400` answers the first row
        that fails, keyed `settings.<index>.<field>` so the form can point at
        it.
        """
        current = await asyncio.to_thread(self._store.list_settings)
        by_id = {setting.id: setting for setting in current}
        built: list[IntegrationSetting] = []
        seen_ids: set[str] = set()

        for index, row in enumerate(rows):
            url = (row.get("url") or "").strip()
            api_user = (row.get("apiUser") or "").strip()
            api_password = row.get("apiPassword") or ""
            existing_id = row.get("id")

            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                raise _field_error(
                    f"settings.{index}.url",
                    "Enter a full system URL, starting with http:// or https://.",
                )
            if not api_user:
                raise _field_error(f"settings.{index}.apiUser", "Enter the API user.")

            kept = existing_id if existing_id in by_id and existing_id not in seen_ids else None
            if kept is None:
                if not api_password:
                    raise _field_error(f"settings.{index}.apiPassword", "Enter the API password.")
                built.append(
                    IntegrationSetting(
                        id=new_setting_id(),
                        url=url,
                        api_user=api_user,
                        api_password=api_password,
                    )
                )
            else:
                seen_ids.add(kept)
                built.append(
                    IntegrationSetting(
                        id=kept,
                        url=url,
                        api_user=api_user,
                        api_password=api_password or by_id[kept].api_password,
                    )
                )

        await asyncio.to_thread(self._store.replace_all, built)
        return built

    async def post_to_core(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Send `payload` to every configured system (D19).

        One outbound POST per stored setting, HTTP Basic with the stored
        credentials. The answer is always a `200` describing each target —
        `posted` for the systems that took it, `failed` (with one of the safe
        reasons above) for the rest — so a browser can report partial success
        honestly. Only "nothing is configured" is an error: without it a
        silent all-empty result would look like success.
        """
        targets = await self.list_settings()
        if not targets:
            raise AppError(ErrorCode.INVALID_REQUEST, message=NO_SETTINGS_MESSAGE)

        posted: list[str] = []
        failed: list[dict[str, str]] = []
        async with httpx.AsyncClient(
            transport=self._transport, timeout=POST_TIMEOUT_SECONDS
        ) as client:
            for target in targets:
                try:
                    response = await client.post(
                        target.url,
                        json=payload,
                        auth=(target.api_user, target.api_password),
                    )
                except httpx.TimeoutException:
                    failed.append({"url": target.url, "reason": REASON_TIMEOUT})
                except httpx.TransportError:
                    failed.append({"url": target.url, "reason": REASON_UNREACHABLE})
                else:
                    if 200 <= response.status_code < 300:
                        posted.append(target.url)
                    elif response.status_code in (401, 403):
                        failed.append({"url": target.url, "reason": REASON_CREDENTIALS})
                    else:
                        failed.append({"url": target.url, "reason": REASON_REJECTED})

        return {"posted": posted, "failed": failed}


def _field_error(field: str, message: str) -> AppError:
    return AppError(ErrorCode.INVALID_REQUEST, message=message, field_errors={field: message})
