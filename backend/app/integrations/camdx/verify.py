"""Verification provider abstraction (§21) and the normalized result (§23).

Identity verification reaches CamDigiKey through four APIs — #1 through #4 — and
the browser must never see a CamDigiKey response shape (§23). So every provider
returns a `VerificationOutcome`: one internal structure the UI can render without
knowing which vendor produced it. Adding a real provider later changes nothing
downstream.

Deliberately absent from `VerificationOutcome`: any match score. §24 forbids
showing internal score fields, and this application has no administrator view that
would justify exposing them. A real provider that returns a score maps it to a
boolean outcome and drops the number, so there is no score in the payload to leak
by accident.
"""

from __future__ import annotations

import abc
import logging
from dataclasses import dataclass, field
from typing import Protocol

from app.core.errors import AppError, ErrorCode
from app.domain.enums import VerificationMethod, VerificationStatus

logger = logging.getLogger("camdx.camdx.verify")


@dataclass(frozen=True, slots=True)
class FieldOutcome:
    """One identity field's comparison result.

    Only the three §23 states. `not_checked` exists because a field the provider
    did not compare must not be rendered as a pass — an unchecked field shown as
    matched is precisely the "false confidence" failure §25 warns about.
    """

    field_name: str
    status: str
    #: What the submitted value was. Kept so the report can echo the user's own
    #: input rather than a value the user cannot see.
    submitted: str | None = None


@dataclass(frozen=True, slots=True)
class VerificationOutcome:
    """A verification result in our own shape (§23).

    Every section carries `required` so the report can omit sections a method
    never used — API #1 shows no face or ID Card section (§25).
    """

    status: VerificationStatus
    method: VerificationMethod
    identity: dict[str, FieldOutcome] = field(default_factory=dict)
    face: bool | None = None
    id_card: bool | None = None
    liveness: bool | None = None

    @property
    def incorrect_fields(self) -> tuple[str, ...]:
        """Identity field names the provider reported as mismatched."""
        return tuple(
            name for name, outcome in self.identity.items() if outcome.status == "mismatch"
        )

    @property
    def is_success(self) -> bool:
        return self.status is VerificationStatus.SUCCESS


class VerifyProvider(abc.ABC):
    """Executes one of the four verification APIs (§21).

    One method per provider so a real implementation can be added per API without
    the mock and the real path being mixed (§21). Implementations translate an
    upstream response into a `VerificationOutcome` and must never let upstream
    text or status escape (§28).
    """

    #: The API this provider implements. Used to reject a mismatched wiring.
    method: VerificationMethod

    @abc.abstractmethod
    async def verify(
        self,
        *,
        identity: dict[str, str],
        id_card: bytes | None,
        current_face: bytes | None,
        liveness: bytes | None,
    ) -> VerificationOutcome:
        """Run the verification and return a normalized outcome.

        Arguments are already resolved bytes: the requirement gate has decided
        which are required and the artefact store has read them. A provider that
        receives `None` for something its API requires has been wired wrong.
        """


class VerifyUpstreamError(AppError):
    """A verification call failed upstream.

    Carries no upstream text, status or payload. The operator sees the request id;
    the user sees a plain sentence (§28).
    """

    def __init__(self, *, code: ErrorCode = ErrorCode.UPSTREAM_UNAVAILABLE) -> None:
        super().__init__(code)


class MockVerifyProviderMarker(Protocol):
    """Marker protocol documenting the concrete providers in this package."""

    name: str


__all__ = [
    "FieldOutcome",
    "VerificationOutcome",
    "VerifyProvider",
    "VerifyUpstreamError",
]
