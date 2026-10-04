"""Mock OCR provider.

Returns deterministic fixtures so the whole flow is exercisable offline, and
never in production: `CAMDX_MODE=real` requires credentials and fails at startup
otherwise (§21).

The fixtures are obviously fake on purpose. A reader who sees
`000000000000` or `SAMPLE` in the UI knows immediately that identity data came
from a fixture rather than from a government service, which is the opposite of
the "never generate fake identity information" trap in §16 — mock data must be
unmistakable, not plausible.
"""

from __future__ import annotations

import logging

from app.domain.enums import DocumentType, OcrStatus
from app.domain.models import IdentityData, OcrResult
from app.integrations.camdx.ocr import OcrProvider

logger = logging.getLogger("camdx.camdx.ocr.mock")


class MockOcrProvider(OcrProvider):
    """Fixture-backed OCR.

    `unreadable` is a constructor flag rather than a magic filename: it lets the
    tests drive the OCR_UNREADABLE branch without shipping a broken JPEG, and
    without any real image ever entering the repository (§29).
    """

    def __init__(self, *, unreadable: bool = False) -> None:
        self._unreadable = unreadable

    @property
    def name(self) -> str:
        return "mock"

    async def read_id_card(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        """Return fixed Khmer ID-card fields.

        `date_of_birth` is deliberately left unextracted so the §16 fallback
        ("Please enter this information") is reachable in normal mock use and the
        UI's handling of a missing field is exercised by default.
        """
        logger.info("mock ocr: id card", extra={"size_bytes": len(image_bytes)})
        if self._unreadable:
            return OcrResult(
                status=OcrStatus.UNREADABLE.value,
                identity=IdentityData(),
                document_type=None,
                missing_fields=("nationalId", "firstNameKhmer", "lastNameKhmer"),
            )

        identity = IdentityData(
            national_id="000000000000",
            first_name_khmer="\u1798\u17d2\u179a\u17b8\u1798\u17c1",
            last_name_khmer="\u179a\u17b7\u1794\u1780",
            first_name_english="SAMPLE",
            last_name_english="PERSON",
            date_of_birth=None,
            gender="M",
            issued_date="2020-01-01",
            expiry_date="2030-01-01",
        )
        missing = _missing_fields(identity, required=_REQUIRED_ID_FIELDS)
        return OcrResult(
            status=status_for(identity, missing),
            identity=identity,
            document_type=DocumentType.KHMER_ID_CARD,
            missing_fields=missing,
        )

    async def read_passport(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        """Return fixed passport fields (§16: API 6 is reachable independently)."""
        logger.info("mock ocr: passport", extra={"size_bytes": len(image_bytes)})
        if self._unreadable:
            return OcrResult(
                status=OcrStatus.UNREADABLE.value,
                identity=IdentityData(),
                document_type=None,
                missing_fields=("nationalId", "firstNameKhmer", "lastNameKhmer"),
            )

        identity = IdentityData(
            national_id="P00000000",
            first_name_khmer=None,
            last_name_khmer=None,
            first_name_english="SAMPLE",
            last_name_english="PASSPORT",
            date_of_birth="1990-05-05",
            gender="F",
            issued_date="2021-06-06",
            expiry_date="2031-06-06",
        )
        # A passport is romanised, so Khmer names are not expected on one and their
        # absence is not a gap the user should be asked to fill in.
        missing = _missing_fields(identity, required=_REQUIRED_PASSPORT_FIELDS)
        return OcrResult(
            status=status_for(identity, missing),
            identity=identity,
            document_type=DocumentType.PASSPORT,
            missing_fields=missing,
        )


def _missing_fields(identity: IdentityData, *, required: tuple[str, ...]) -> tuple[str, ...]:
    """Names of the required fields OCR could not read.

    Only fields the document is actually expected to carry count. Absent Khmer
    names on a romanised passport are not a gap, and reporting them as one would
    put fields on screen the user can do nothing about.
    """
    return tuple(name for name in required if getattr(identity, _ATTRIBUTE_FOR[name]) is None)


#: Fields a Khmer ID card is expected to carry, in either script. Anything absent
#: becomes `partial`. The Khmer variants lead because a card prints them first.
_REQUIRED_ID_FIELDS = ("nationalId", "firstNameKhmer", "lastNameKhmer", "dateOfBirth", "gender")

#: A passport is romanised, so its expected fields are the English name pair.
_REQUIRED_PASSPORT_FIELDS = (
    "nationalId",
    "firstNameEnglish",
    "lastNameEnglish",
    "dateOfBirth",
    "gender",
)

_ATTRIBUTE_FOR = {
    "nationalId": "national_id",
    "firstNameKhmer": "first_name_khmer",
    "lastNameKhmer": "last_name_khmer",
    "firstNameEnglish": "first_name_english",
    "lastNameEnglish": "last_name_english",
    "dateOfBirth": "date_of_birth",
    "gender": "gender",
    "issuedDate": "issued_date",
    "expiryDate": "expiry_date",
}


def status_for(identity: IdentityData, missing: tuple[str, ...]) -> str:
    """Derive the status from what was and was not read.

    Deriving instead of hard-coding removes the possibility of a result claiming
    `completed` while simultaneously listing a missing field, which is how a
    half-empty form would end up presented as a complete read.
    """
    if identity.is_empty:
        return OcrStatus.UNREADABLE.value
    return OcrStatus.PARTIAL.value if missing else OcrStatus.COMPLETED.value
