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
from urllib.parse import urlparse

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


class IntegrationService:
    """Settings CRUD for core-system posting (D19)."""

    def __init__(self, settings: Settings) -> None:
        self._store = IntegrationStore(resolve_integration_database_url(settings.database_url))

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


def _field_error(field: str, message: str) -> AppError:
    return AppError(ErrorCode.INVALID_REQUEST, message=message, field_errors={field: message})
