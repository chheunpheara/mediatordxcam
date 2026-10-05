"""Verification against the stored sample identity records (D13).

The registry stands in for CamDigiKey's record lookup: `POST /verify` compares
the submitted identity against a stored record and reports per-field results
(§26). It is explicitly *not* a claim about anyone real — the seeded rows are
fixtures (`app/infrastructure/db.py`) — and it is never a silent fallback: with
`CAMDX_MODE=real` the provider selection stops for the real adapter first, so
the registry can only answer while the real integration is still unwired
(`docs/camdx-integration.md`).

Precedence, highest first (D13):

1. Real CamDigiKey adapter — `CAMDX_MODE=real`, not implemented yet.
2. This registry — `DATABASE_URL` set.
3. Fixture provider — the default, and what every test runs on.

The comparison rules themselves are `app/domain/verification.py`. This module
only reads the record, shapes the provider's result, and translates a database
fault into a business error (§28).
"""

from __future__ import annotations

import asyncio
import logging

from app.core.errors import AppError, ErrorCode
from app.domain.enums import RequirementFlag, VerificationMethod
from app.domain.models import IdentityData
from app.domain.requirements import IDENTITY_FIELD_NAMES, requirements_for
from app.domain.verification import compare_identity, derive_verification_status
from app.infrastructure.db import RegistryUnavailableError, find_identity_record
from app.integrations.camdx.verify import FieldOutcome, VerificationOutcome, VerifyProvider

logger = logging.getLogger("camdx.registry")


class IdentityRegistry:
    """Async read access to the stored identity records.

    Queries run in a worker thread (`asyncio.to_thread`): the SQLAlchemy engine
    is synchronous, and blocking the event loop on a database round-trip would
    stall every other request behind it.
    """

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def find(self, national_id: str) -> IdentityData | None:
        """The record for this national ID, or `None` when it is unknown.

        A database fault becomes `UPSTREAM_UNAVAILABLE`: the record source is
        upstream of the comparison, the user is told the verification service is
        briefly unavailable, and no driver text or DSN reaches the client (§28).
        """
        try:
            return await asyncio.to_thread(find_identity_record, self._database_url, national_id)
        except RegistryUnavailableError as exc:
            logger.exception("identity registry lookup failed")
            raise AppError(ErrorCode.UPSTREAM_UNAVAILABLE) from exc


class DatabaseVerifyProvider(VerifyProvider):
    """Compare submitted identity against one stored record (§23, §26).

    Section claims beyond identity are limited to what the registry can
    honestly answer:

    * `id_card` — the identity read from the card resolved to a stored record
      (or did not). A real adapter compares the image server-side; there is no
      card image here to compare, and claiming more would be the false
      confidence §25 warns about.
    * `face` — whether a record exists for the local face comparison to be
      against. `KycService` replaces it with the actual local comparison
      (§12/§13) for every method that requires a face.
    * `liveness` — never claimed: the registry holds no liveness opinion, and
      API 4 is not runnable in this build anyway (§11).
    """

    method: VerificationMethod

    def __init__(self, method: VerificationMethod, registry: IdentityRegistry) -> None:
        self.method = method
        self._registry = registry

    @property
    def name(self) -> str:
        return "registry"

    async def verify(
        self,
        *,
        identity: dict[str, str],
        id_card: bytes | None,
        current_face: bytes | None,
        liveness: bytes | None,
    ) -> VerificationOutcome:
        """Look the national ID up, then compare every §14 field individually."""
        national_id = (identity.get("nationalId") or "").strip()
        record = await self._registry.find(national_id)

        statuses = compare_identity(identity, record)
        outcomes = {
            name: FieldOutcome(
                field_name=name,
                status=statuses[name].value,
                submitted=(identity.get(name) or "").strip() or None,
            )
            for name in IDENTITY_FIELD_NAMES
        }

        known = record is not None
        face = None if current_face is None else known
        id_card_ok = None if id_card is None else known

        required = requirements_for(self.method).requires
        sections = [
            value
            for flag, value in (
                (RequirementFlag.CURRENT_FACE, face),
                (RequirementFlag.ID_CARD, id_card_ok),
                (RequirementFlag.LIVENESS, None),
            )
            if flag in required
        ]
        status = derive_verification_status(statuses, sections=sections)

        logger.info(
            "registry verify",
            extra={
                "method": self.method.value,
                "status": status.value,
                "source": self.name,
                "record_found": known,
            },
        )
        return VerificationOutcome(
            status=status,
            method=self.method,
            identity=outcomes,
            face=face,
            id_card=id_card_ok,
            liveness=None,
        )


__all__ = ["DatabaseVerifyProvider", "IdentityRegistry"]
