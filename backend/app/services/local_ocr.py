"""Local Tesseract-based OCR.

The platform never talks to a real CamDX host (§21). Capturing the data from an
uploaded ID Card or passport is still a real operation, so it is done here with a
local OCR engine rather than a fixture.

This is best-effort: §16 says an OCR that could not read a value must leave the
field for the user to enter, never guess. Missing fields are therefore reported in
`missing_fields`, and an unreadable card yields `OCR_UNREADABLE` upstream.
"""

from __future__ import annotations

import io
import logging
import re
from datetime import datetime

import pytesseract
from PIL import Image

from app.domain.enums import DocumentType, OcrStatus
from app.domain.models import IdentityData, OcrResult
from app.integrations.camdx.ocr import OcrProvider, OcrUpstreamError

logger = logging.getLogger("camdx.ocr.local")

#: Required fields the UI prompts for when OCR cannot read them (§16).
_REQUIRED_ID_FIELDS = ("nationalId", "firstNameKhmer", "lastNameKhmer", "dateOfBirth", "gender")
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

_DATE_RE = re.compile(r"\b(\d{1,2}[-/.\s]\s*\d{1,2}[-/.\s]\s*\d{2,4})\b")
_KHMER_RE = re.compile(r"[\u1780-\u17ff]")


class LocalTesseractOcrProvider(OcrProvider):
    """Real on-device capture via Tesseract (no CamDX call)."""

    def __init__(self, *, languages: str = "eng+khm") -> None:
        self._languages = languages

    @property
    def name(self) -> str:
        return "tesseract"

    async def read_id_card(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        text = self._ocr_text(image_bytes)
        identity = self._parse_id_card(text)
        return self._result(identity, required=_REQUIRED_ID_FIELDS, doc=DocumentType.KHMER_ID_CARD)

    async def read_passport(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        text = self._ocr_text(image_bytes)
        identity = self._parse_passport(text)
        return self._result(identity, required=_REQUIRED_PASSPORT_FIELDS, doc=DocumentType.PASSPORT)

    # -- OCR ----------------------------------------------------------------

    def _ocr_text(self, image_bytes: bytes) -> str:
        try:
            img = Image.open(io.BytesIO(image_bytes)).convert("L")
        except Exception as exc:
            raise OcrUpstreamError() from exc
        width, height = img.size
        if max(width, height) < 1600:
            scale = 1600 / max(width, height)
            img = img.resize((int(width * scale), int(height * scale)))
        try:
            return str(pytesseract.image_to_string(img, lang=self._languages))
        except Exception as exc:
            raise OcrUpstreamError() from exc

    # -- Parsing ------------------------------------------------------------

    def _parse_id_card(self, text: str) -> IdentityData:
        # Remove the ID number from the image-only date search but keep context.
        id_number = self._find(text, r"(\d{6,15})")
        data = IdentityData(
            national_id=id_number,
            first_name_khmer=self._khmer_value(text, index=0),
            last_name_khmer=self._khmer_value(text, index=1),
            first_name_english=self._after_label(text, (r"first\s*name", r"នាម")),
            last_name_english=self._after_label(text, (r"last\s*name", r"នាមត្រកូល")),
            date_of_birth=self._normalise_date(
                self._after_label(text, (r"date\s*of\s*birth", r"ថ្ងៃ[ ,|/]*ខែ[ ,|/]*ទី[ ,|/]*កំណើត"))
            ),
            gender=self._gender(text),
            issued_date=self._normalise_date(
                self._after_label(text, (r"issued", r"date\s*of\s*issue", r"ចុះបញ្ជី"))
                or self._after_label(text, (r"លេខប័ណ្ណ", r"ចំនួន"))
            ),
            expiry_date=self._normalise_date(
                self._after_label(text, (r"exp\.??\s*date", r"expiry", r"due", r"អាយុ"))
            ),
        )
        return data

    def _parse_passport(self, text: str) -> IdentityData:
        return IdentityData(
            national_id=self._find(text, r"([A-Z]?\d{6,9})")
            or self._after_label(text, (r"passport\s*no", r"document\s*no", r"លេខ")),
            first_name_english=self._after_label(text, (r"given\s*names?", r"first\s*name"))
            or self._first_name_mrz(text),
            last_name_english=self._after_label(text, (r"surname", r"last\s*name")),
            date_of_birth=self._normalise_date(self._after_label(text, (r"date\s*of\s*birth",))),
            gender=self._gender(text),
            expiry_date=self._normalise_date(
                self._after_label(text, (r"date\s*of\s*expiry", r"expiry"))
            ),
        )

    # -- Helpers ------------------------------------------------------------

    def _result(
        self, identity: IdentityData, *, required: tuple[str, ...], doc: DocumentType
    ) -> OcrResult:
        missing = tuple(
            name for name in required if getattr(identity, _ATTRIBUTE_FOR[name]) is None
        )
        if identity.is_empty:
            status = OcrStatus.UNREADABLE.value
        elif missing:
            status = OcrStatus.PARTIAL.value
        else:
            status = OcrStatus.COMPLETED.value
        return OcrResult(
            status=status, identity=identity, document_type=doc, missing_fields=missing
        )

    def _find(self, text: str, pattern: str) -> str | None:
        match = re.search(pattern, text)
        return match.group(1) if match else None

    def _after_label(self, text: str, labels: tuple[str, ...]) -> str | None:
        for label in labels:
            pattern = re.compile(rf"{label}[:\s]+([^\n;]+)", re.IGNORECASE | re.UNICODE)
            match = pattern.search(text)
            if match:
                value = match.group(1).strip(" .:|-\t")
                if value:
                    return value
        return None

    def _khmer_value(self, text: str, *, index: int) -> str | None:
        lines = [line.strip() for line in text.splitlines() if _KHMER_RE.search(line)]
        if not lines:
            return None
        # First Khmer-script lines are typically the holder's Khmer name.
        if index < len(lines):
            return lines[index]
        return None

    def _normalise_date(self, value: str | None) -> str | None:
        if not value:
            return None
        if re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}", value):
            return value
        match = _DATE_RE.search(value)
        if not match:
            return None
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d %m %Y", "%d-%m-%y"):
            try:
                return datetime.strptime(match.group(1), fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        return None

    def _gender(self, text: str) -> str | None:
        match = re.search(r"\b(male|female|m|f|ប្រុស|ស្រី)\b", text, re.IGNORECASE | re.UNICODE)
        if not match:
            return None
        token = match.group(1).lower()
        if token in ("m", "male", "ប្រុស"):
            return "M"
        return "F"

    def _first_name_mrz(self, text: str) -> str | None:
        match = re.search(r"<<([A-Z<]+)<", text)
        if match:
            return match.group(1).replace("<", " ").strip() or None
        return None
