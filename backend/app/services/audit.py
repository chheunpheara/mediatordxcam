"""The audit trail service (D25): who did what, recorded when it happens.

The application layer over `infrastructure/audit_store`. It owns two things
the store deliberately does not: masking the payload before any plaintext
reaches the database, and the lifecycle rules of each wired action.

Two-phase by design for `POST_TO_CORE`, because the requirement is an entry
at the millisecond of the click and truth about what happened afterwards:

1. `begin_post` writes a `PENDING` row in its own committed transaction,
   *before* the outbound call. This write is fail-closed: if the audit trail
   cannot record the click, the post does not happen (no audit, no action).
2. `finalize_post` moves it once to `SUCCESS` or `FAILED` with the target
   systems' error responses. This write is best-effort: the post has already
   left the building, and answering `500` for a delivery that succeeded would
   only invite a duplicate submission. A row left `PENDING` is itself the
   signal that finalisation failed.

`IDENTITY_VERIFIED` is a single-shot insert (born terminal): an audit record
of a completed or refused verification, best-effort so a broken audit table
can never take the KYC flow down with it.

Masking (§29, requirement 3): the snapshot stored is masked *before* the
store sees it, so a full national ID never lands in the table even though the
same value travelled to the core system seconds earlier. The national ID keeps
its first three and last two characters - enough for a compliance manager to
confirm it is the same document, not enough to be the document. Known secret
keys (private keys, API keys, tokens, passwords) become `***`. The biometric
score column exists for the schema contract but stays `NULL`: this build has
no liveness or face-match percentage to record, and §24 forbids passing any
other number off as one.

Every blocking call runs in a worker thread (`asyncio.to_thread`), matching
the other services: a database round-trip must not stall the event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Literal

from app.core.config import Settings
from app.domain.auth import User
from app.infrastructure.audit_store import (
    AuditActionType,
    AuditLogEntry,
    AuditStatus,
    AuditStore,
    AuditStoreError,
    new_audit_id,
    resolve_audit_database_url,
)
from app.schemas.verification import VerifyRequest, VerifyResponse

logger = logging.getLogger("camdx.audit")

#: What a masked national ID looks like: first three characters, `***`, last
#: two. Shorter values are replaced outright - a fragment of a short identifier
#: is the identifier.
_MASK = "***"
_NATIONAL_ID_KEYS = frozenset({"nationalid"})

#: Keys whose value is a credential, never evidence: fully masked. Matching is
#: on the key with case and underscores folded away, so `privateKey`,
#: `private_key` and `PRIVATE_KEY` behave the same.
_SECRET_KEYS = frozenset(
    {
        "apikey",
        "accesstoken",
        "clientsecret",
        "password",
        "pin",
        "privatekey",
        "refreshtoken",
        "secret",
        "seed",
        "token",
    }
)


class AuditService:
    """Append-only audit actions for the gateway (D25)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        #: Built on first use, inside a worker thread: constructing the store
        #: runs DDL, and a broken DSN must surface as a failed *write* (or a
        #: refused read), never as a dependency crash that would mask the
        #: error the request itself is trying to report.
        self._store: AuditStore | None = None

    def _store_or_create(self) -> AuditStore:
        if self._store is None:
            self._store = AuditStore(resolve_audit_database_url(self._settings.database_url))
        return self._store

    async def begin_post(
        self,
        *,
        user: User,
        payload: dict[str, Any],
        target_urls: list[str],
    ) -> str:
        """Write the `PENDING` entry for a Post-to-Core click; returns its id.

        Fail-closed (D25): a click that cannot be recorded is a click that
        does not go out.
        """
        entry = AuditLogEntry(
            id=new_audit_id(),
            created_at=time.time(),
            staff_id=user.id,
            staff_email=user.email,
            staff_role=_role_names(user),
            action_type="POST_TO_CORE",
            target_system_url=_join_targets(target_urls),
            payload=mask_payload(payload),
            biometric_confidence_score=None,
            status="PENDING",
            error_response=None,
            completed_at=None,
        )

        def work() -> None:
            self._store_or_create().append(entry)

        await asyncio.to_thread(work)
        return entry.id

    async def finalize_post(
        self,
        entry_id: str,
        *,
        outcome: dict[str, Any] | None,
        failure: str | None,
    ) -> None:
        """Record how the post ended; never raises (see the module docstring).

        `failure` is set when the post was refused before any target was
        called (nothing configured, an unexpected fault); otherwise `outcome`
        carries the per-target results and any failure list both finalises the
        row as `FAILED` and becomes the captured error responses.
        """
        error_response: str | None
        status: Literal["SUCCESS", "FAILED"]
        if failure is not None:
            status = "FAILED"
            error_response = json.dumps({"error": failure})
        else:
            failed = (outcome or {}).get("failed") or []
            if failed:
                status = "FAILED"
                error_response = json.dumps(failed)
            else:
                status = "SUCCESS"
                error_response = None

        def work() -> None:
            self._store_or_create().finalize(
                entry_id,
                status=status,
                error_response=error_response,
                completed_at=time.time(),
            )

        try:
            await asyncio.to_thread(work)
        except AuditStoreError:
            logger.exception("audit entry was not finalised", extra={"entry_id": entry_id})

    async def record_verification(
        self,
        *,
        user: User,
        request: VerifyRequest,
        response: VerifyResponse | None,
        failure: str | None,
    ) -> None:
        """Best-effort single-shot entry for one verification attempt (D25).

        `failure` set means the attempt was refused or the adapter errored;
        the row is born `FAILED`. Otherwise it is born `SUCCESS` with the
        request and outcome as the snapshot - the identity fields masked, the
        verification decision intact.
        """
        payload: dict[str, Any] = {
            "request": mask_payload(request.model_dump()),
            "response": mask_payload(response.model_dump()) if response is not None else None,
            "failure": failure,
        }
        entry = AuditLogEntry(
            id=new_audit_id(),
            created_at=time.time(),
            staff_id=user.id,
            staff_email=user.email,
            staff_role=_role_names(user),
            action_type="IDENTITY_VERIFIED",
            target_system_url=None,
            payload=payload,
            biometric_confidence_score=None,
            status="FAILED" if failure is not None else "SUCCESS",
            error_response=json.dumps({"error": failure}) if failure is not None else None,
            completed_at=time.time(),
        )

        def work() -> None:
            self._store_or_create().append(entry)

        try:
            await asyncio.to_thread(work)
        except AuditStoreError:
            logger.exception("verification audit entry was not written")

    async def list_logs(
        self,
        *,
        staff_id: str | None = None,
        action_type: AuditActionType | None = None,
        status: AuditStatus | None = None,
        date_from: float | None = None,
        date_to: float | None = None,
        limit: int = 25,
        offset: int = 0,
    ) -> tuple[list[AuditLogEntry], int]:
        """One filtered page, newest first, plus the matched total."""

        def work() -> tuple[list[AuditLogEntry], int]:
            return self._store_or_create().list_entries(
                staff_id=staff_id,
                action_type=action_type,
                status=status,
                date_from=date_from,
                date_to=date_to,
                limit=limit,
                offset=offset,
            )

        return await asyncio.to_thread(work)


def mask_payload(value: Any) -> Any:
    """Return a copy of `value` with sensitive customer data masked (§29).

    Three rules, applied recursively through objects and lists: national-ID
    keys (and a `submitted` value beside `field: "nationalId"`) keep only
    their first three and last two characters; secret keys become `***`;
    everything else - the verification decision, the method, the timestamps -
    passes through untouched, because the snapshot must stay evidence.
    """
    if isinstance(value, dict):
        hide_submitted = str(value.get("field", "")).lower() in _NATIONAL_ID_KEYS
        masked: dict[str, Any] = {}
        for key, item in value.items():
            normalised = str(key).lower().replace("_", "")
            if normalised in _NATIONAL_ID_KEYS:
                masked[key] = _mask_national_id(item)
            elif normalised in _SECRET_KEYS:
                masked[key] = _MASK if item is not None else None
            elif hide_submitted and normalised == "submitted":
                masked[key] = _mask_national_id(item)
            else:
                masked[key] = mask_payload(item)
        return masked
    if isinstance(value, list):
        return [mask_payload(item) for item in value]
    return value


def _mask_national_id(value: Any) -> Any:
    """First three characters, `***`, last two; `None` stays `None`."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value) < 8:
        return _MASK
    return f"{value[:3]}{_MASK}{value[-2:]}"


def _role_names(user: User) -> str:
    """The SSO role names held right now, comma-separated for the column.

    The gateway has no separate Maker/Checker vocabulary: `staff_role`
    records whatever the account server says (Admin, Loan Officer, ...), so a
    bank mapping Maker and Checker onto roles gets them here verbatim.
    """
    return ", ".join(role.name for role in user.roles) or "No role"


def _join_targets(urls: list[str]) -> str | None:
    """The configured destinations for `target_system_url`, column-safe."""
    if not urls:
        return None
    joined = ", ".join(urls)
    return joined[:2045] + "..." if len(joined) > 2048 else joined
