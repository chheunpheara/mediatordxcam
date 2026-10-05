"""Uploaded records and the saved column mapping (D23).

The application layer over `infrastructure/record_store`: it owns the
validation the endpoints rely on (a record must carry at least one value, a
mapping must name real §14 fields and map each of them once) and hands the
store only rows it can persist. Every blocking call runs in a worker thread
(`asyncio.to_thread`), matching the other services: a database round-trip must
not stall the event loop.

Values arrive as the nine §14 fields with `None` for "the file had no value",
are stripped and stored as blanks, so what the list shows and what the form
later loads are the same strings (§14, §16).
"""

from __future__ import annotations

import asyncio
import time

from app.core.config import Settings
from app.core.errors import AppError, ErrorCode
from app.infrastructure.record_store import (
    RecordStatusValue,
    RecordStore,
    StoredRecord,
    new_record_id,
    resolve_record_database_url,
)

#: The lifecycle words the list filters and renders (D23).
STATUS_PENDING: RecordStatusValue = "pending"
STATUS_VERIFIED: RecordStatusValue = "verified"

NO_RECORD_MESSAGE = "That record could not be found."
EMPTY_VALUES_MESSAGE = "Enter at least one value for this record."
BLANK_COLUMN_MESSAGE = "A mapped column name cannot be blank."
DUPLICATE_FIELD_MESSAGE = "Each system field can be mapped only once."


def _field_error(field: str, message: str) -> AppError:
    return AppError(ErrorCode.INVALID_REQUEST, message=message, field_errors={field: message})


class RecordService:
    """Record listing, creation, verification storage and the mapping (D23)."""

    def __init__(self, settings: Settings) -> None:
        self._store = RecordStore(resolve_record_database_url(settings.database_url))

    async def list_records(
        self,
        *,
        search: str | None,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[StoredRecord], int]:
        """A filtered, paged slice of the list, newest record first."""
        term = search.strip() if search else None
        return await asyncio.to_thread(
            self._store.list_records,
            search=term or None,
            status=status,
            limit=limit,
            offset=offset,
        )

    async def create_records(self, rows: list[dict[str, str | None]]) -> list[StoredRecord]:
        """Validate and persist one submission; returns what was stored.

        Each row is the nine §14 keys with `None` for an absent value. A row
        with nothing in it would be a record nobody can ever verify, so it is
        refused with `records.<index>.values` — the same dotted-key convention
        the posting settings use.
        """
        now = time.time()
        built: list[StoredRecord] = []
        for index, row in enumerate(rows):
            values = {name: (value or "").strip() for name, value in row.items()}
            if not any(values.values()):
                raise _field_error(f"records.{index}.values", EMPTY_VALUES_MESSAGE)
            built.append(
                StoredRecord(
                    id=new_record_id(),
                    status=STATUS_PENDING,
                    values=values,
                    verification=None,
                    created_at=now,
                    verified_at=None,
                )
            )
        await asyncio.to_thread(self._store.add_records, built)
        return built

    async def save_verification(
        self, record_id: str, verification: dict[str, object]
    ) -> StoredRecord:
        """Store the outcome on its record and mark it verified (D23).

        The list's Status column and the Preview dialog both read this; an
        unknown id is a `404` so a stale tab cannot silently "verify" nothing.
        """
        updated = await asyncio.to_thread(
            self._store.update_verification, record_id, verification, time.time()
        )
        if updated is None:
            raise AppError(ErrorCode.NOT_FOUND, message=NO_RECORD_MESSAGE)
        return updated

    async def get_mapping(self) -> dict[str, str] | None:
        """The saved default mapping, or `None` when nothing was saved yet."""
        return await asyncio.to_thread(self._store.get_mapping)

    async def save_mapping(self, mapping: dict[str, str]) -> dict[str, str]:
        """Validate and upsert the one reusable mapping.

        The schema already rejected unknown §14 field names (a stray name is a
        `400` keyed `mapping.<column>`); what remains here is what only makes
        sense across the whole object — blank column names, and one field
        claimed by two columns, keyed by the column that repeated it.
        """
        normalized: dict[str, str] = {}
        seen: dict[str, str] = {}
        for column, field in mapping.items():
            column = column.strip()
            if not column:
                raise _field_error("mapping", BLANK_COLUMN_MESSAGE)
            if field in seen:
                raise _field_error(f"mapping.{column}", DUPLICATE_FIELD_MESSAGE)
            seen[field] = column
            normalized[column] = field
        await asyncio.to_thread(self._store.save_mapping, normalized)
        return normalized
