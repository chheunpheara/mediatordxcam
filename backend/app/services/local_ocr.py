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

#: Tesseract sometimes returns Khmer numerals where the card prints Latin 0-9.
_KHMER_DIGITS = str.maketrans("០១២៣៤៥៦៧៨៩", "0123456789")


class LocalTesseractOcrProvider(OcrProvider):
    """Real on-device capture via Tesseract (no CamDX call)."""

    def __init__(
        self,
        *,
        languages: str = "eng+khm",
        ollama_base_url: str | None = None,
        ollama_model: str = "llama3.1",
    ) -> None:
        self._languages = languages
        from app.services.nlp_extract import OllamaFieldExtractor

        self._nlp = OllamaFieldExtractor(base_url=ollama_base_url, model=ollama_model)

    @property
    def name(self) -> str:
        return "tesseract"

    async def read_id_card(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        text = self._ocr_text(image_bytes)
        nlp = self._nlp.extract(text)
        rule = self._parse_id_card(text)
        identity = self._merge_rule_with_nlp(rule, nlp)
        return self._result(identity, required=_REQUIRED_ID_FIELDS, doc=DocumentType.KHMER_ID_CARD)

    async def read_passport(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        text = self._ocr_text(image_bytes)
        nlp = self._nlp.extract(text)
        rule = self._parse_passport(text)
        identity = self._merge_rule_with_nlp(rule, nlp)
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
            clean = pytesseract.image_to_string(img, lang=self._languages)
            # Second pass on a binarized image — helps low-contrast scans.
            bw = img.point(lambda p: 255 if p > 140 else 0)
            threshold = pytesseract.image_to_string(bw, lang=self._languages)
        except Exception as exc:
            raise OcrUpstreamError() from exc
        # Prefer the pass that preserves more Khmer glyphs (ID cards print the
        # name in Khmer); fall back to the one with the most total content.
        if len(_KHMER_RE.findall(threshold)) > len(_KHMER_RE.findall(clean)):
            return str(threshold.translate(_KHMER_DIGITS))
        return str(clean.translate(_KHMER_DIGITS))

    def _looks_khmer(self, value: str | None) -> bool:
        return bool(value) and _KHMER_RE.search(value or "") is not None

    def _merge_rule_with_nlp(self, rule: IdentityData, nlp: IdentityData | None) -> IdentityData:
        base = nlp or rule

        def _normalise_id(value: str | None) -> str | None:
            if not value:
                return None
            cleaned = re.sub(r"[\s\-/.,]", "", value).strip()
            return cleaned or None

        first_from_rule = self._looks_khmer(rule.first_name_khmer)
        last_from_rule = self._looks_khmer(rule.last_name_khmer)
        cand_first = (
            rule.first_name_khmer
            if first_from_rule
            else base.first_name_khmer
            if self._looks_khmer(base.first_name_khmer)
            else None
        )
        cand_last = (
            rule.last_name_khmer
            if last_from_rule
            else base.last_name_khmer
            if self._looks_khmer(base.last_name_khmer)
            else None
        )
        # Avoid pouring the same single Khmer token into both name slots.
        if cand_first and cand_last and cand_first == cand_last:
            if first_from_rule and not last_from_rule:
                cand_last = None
            elif last_from_rule and not first_from_rule:
                cand_first = None
            else:
                cand_first = None
                cand_last = None

        return IdentityData(
            national_id=_normalise_id(rule.national_id) or _normalise_id(base.national_id),
            first_name_khmer=cand_first,
            last_name_khmer=cand_last,
            first_name_english=base.first_name_english or rule.first_name_english,
            last_name_english=base.last_name_english or rule.last_name_english,
            gender=base.gender or rule.gender,
            date_of_birth=base.date_of_birth or rule.date_of_birth,
            issued_date=base.issued_date or rule.issued_date,
            expiry_date=base.expiry_date or rule.expiry_date,
        )

    # -- Parsing ------------------------------------------------------------

    def _parse_id_card(self, text: str) -> IdentityData:
        national_id = self._national_id(text)
        first_en = self._label_value(
            text, (r"first\s*name", r"given\s*names?", r"នាមដំបូង", r"ឈ្មោះដំបូង"), "en_name"
        )
        last_en = self._label_value(
            text, (r"last\s*name", r"surname", r"family\s*name", r"នាមត្រកូល"), "en_name"
        )
        if (first_en is None or last_en is None) and (
            full := self._label_value(text, (r"full\s*name", r"ឈ្មោះ"), "en_name")
        ):
            parts = full.split()
            if len(parts) > 1:
                first_en = first_en or " ".join(parts[:-1])
                last_en = last_en or parts[-1]
            else:
                first_en = first_en or full

        data = IdentityData(
            national_id=national_id,
            first_name_khmer=self._khmer_field(text, ("នាមដំបូង", "ឈ្មោះដំបូង", "ឈ្មោះ")),
            last_name_khmer=self._khmer_field(text, ("នាមត្រកូល", "ត្រកូល")),
            first_name_english=first_en,
            last_name_english=last_en,
            date_of_birth=(
                self._label_value(
                    text,
                    (r"date\s*of\s*birth", r"dob", r"birth\s*date", r"កំណើត", r"ថ្ងៃកំណើត"),
                    "date",
                )
                or self._birth_candidate(text)
            ),
            gender=self._label_value(text, (r"gender", r"sex", r"ភេទ"), "gender")
            or self._gender(text),
            issued_date=self._label_value(
                text,
                (
                    r"issued\s*date",
                    r"date\s*of\s*issue",
                    r"registration\s*date",
                    r"ថ្ងៃចុះបញ្ជី",
                    r"ចុះបញ្ជី",
                ),
                "date",
            ),
            expiry_date=self._label_value(
                text,
                (
                    r"exp\.??\s*date",
                    r"expir(y|ation)?",
                    r"expires?",
                    r"validity",
                    r"due",
                    r"អាយុ",
                    r"ផុតកំណត់",
                ),
                "date",
            ),
        )
        return data

    def _parse_passport(self, text: str) -> IdentityData:
        return IdentityData(
            national_id=self._national_id(text)
            or self._label_value(text, (r"passport\s*no", r"document\s*no", r"លេខ"), "digits"),
            first_name_english=self._label_value(
                text, (r"given\s*names?", r"first\s*name"), "en_name"
            )
            or self._first_name_mrz(text),
            last_name_english=self._label_value(text, (r"surname", r"last\s*name"), "en_name"),
            date_of_birth=(
                self._label_value(
                    text,
                    (r"date\s*of\s*birth", r"dob", r"birth\s*date", r"កំណើត", r"ថ្ងៃកំណើត"),
                    "date",
                )
                or self._birth_candidate(text)
            ),
            gender=self._label_value(text, (r"sex", r"gender", r"ភេទ"), "gender")
            or self._gender(text),
            expiry_date=self._label_value(
                text, (r"date\s*of\s*expiry", r"expir(y|ation)?", r"expires?", r"ផុតកំណត់"), "date"
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

    # -- Paren/label routed capture helpers ----------------------------------

    def _national_id(self, text: str) -> str | None:
        via_label = self._label_value(
            text, (r"id\s*no", r"national\s*id", r"\bid\b", r"លេខប័ណ្ណ", r"លេខ", r"เลข"), "digits"
        )
        if via_label:
            return via_label
        compact = re.sub(r"\s+", "", text)
        return self._find(compact, r"(\d{6,15})") or self._find(text, r"(\d{6,15})")

    def _khmer_field(self, text: str, labels: tuple[str, ...]) -> str | None:
        return self._label_value(text, tuple(labels), "kh_name")

    def _label_value(self, text: str, labels: tuple[str, ...], kind: str) -> str | None:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        for i, ln in enumerate(lines):
            lower = ln.lower()
            matched_this = False
            for label in labels:
                match = re.search(label, lower)
                if match is None:
                    continue
                matched_this = True
                rest = ln[match.end() :].strip(" :\t|/-")
                if rest and self._match_kind(kind, rest):
                    return self._coerce(kind, rest)
                break
            # Fallback to the next non-label line only when this line is itself a
            # label line for THIS field — never steal an unrelated value line.
            if matched_this:
                for below in lines[i + 1 : i + 5]:
                    if not self._is_label_line(below) and self._match_kind(kind, below):
                        return self._coerce(kind, below)
        return None

    def _match_kind(self, kind: str, value: str) -> bool:
        if kind == "digits":
            cleaned = re.sub(r"[\s\-+()]", "", value)
            return re.search(r"\d{6,15}", cleaned) is not None
        if kind == "en_name":
            stripped = value.strip()
            return (
                len(stripped) >= 2
                and any(c.isalpha() for c in stripped)
                and re.fullmatch(r"[A-Za-z'\-\. ]+", stripped) is not None
            )
        if kind == "date":
            return self._normalise_date(value) is not None
        if kind == "gender":
            return value.strip().lower() in ("m", "f", "male", "female", "ប្រុស", "ស្រី")
        if kind == "kh_name":
            return _KHMER_RE.search(value) is not None
        return False

    def _coerce(self, kind: str, value: str) -> str | None:
        if kind == "digits":
            cleaned = re.sub(r"[\s\-+()]", "", value)
            match = re.search(r"\d{6,15}", cleaned)
            return match.group(0) if match else None
        if kind == "en_name":
            return value.strip()
        if kind == "date":
            return self._normalise_date(value)
        if kind == "gender":
            token = value.strip().lower()
            return "M" if token in ("m", "male", "ប្រុស") else "F"
        if kind == "kh_name":
            return value.strip()
        return None

    def _is_label_line(self, line: str) -> bool:
        lowered = line.lower()
        label_markers = (
            "name",
            "surname",
            "given",
            "ឈ្មោះ",
            "នាម",
            "ត្រកូល",
            "ភេទ",
            "sex",
            "gender",
            "ថ្ងៃ",
            "កំណើត",
            "ចុះបញ្ជី",
            "ផុតកំណត់",
            "លេខ",
            "ប័ណ្ណ",
            "exp",
            "issued",
            "date",
            "id no",
            "dob",
            "birth",
            "expir",
            "valid",
            "registr",
            "full",
            "sex",
            "licence",
            "license",
        )
        return any(marker in lowered for marker in label_markers)

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
        headers = ("ព្រះរាជា", "កម្ពុជា", "KINGDOM", "អត្តសញ្ញាណ", "ប័ណ្ណ", "លេខ", "ចុះ", "ផុត")
        candidates: list[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if (
                stripped
                and _KHMER_RE.search(stripped)
                and not any(h in stripped for h in headers)
                and not self._is_label_line(stripped)
            ):
                candidates.append(stripped)
        return candidates[index] if index < len(candidates) else None

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

    def _birth_candidate(self, text: str) -> str | None:
        """Heuristic when the label is not found: the earliest plausible date.

        A card holder's ID carries one old date (their birth) plus later ones
        (issue, expiry). Picking the oldest sensible date is the best-effort read.
        """
        candidates: list[str] = []
        for m in _DATE_RE.finditer(text):
            iso = self._normalise_date(m.group(0))
            if iso:
                candidates.append(iso)
        if not candidates:
            return None
        candidates.sort()
        for iso in candidates:
            year = int(iso[:4])
            if 1920 <= year <= 2015:
                return iso
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
