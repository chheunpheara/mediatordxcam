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

#: A date as printed on a card: `15/01/2022` or — the usual case on a Cambodian
#: ID — `15 JAN 2022`, which Tesseract reads with the month in Latin letters.
_NUM_DATE = r"\d{1,2}[-/.\s]\s*\d{1,2}[-/.\s]\s*\d{2,4}"
_NAMED_DATE = r"\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}"
_DATE_RE = re.compile(rf"\b((?:{_NUM_DATE})|(?:{_NAMED_DATE}))\b")
_NAMED_DATE_RE = re.compile(r"(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})")
_KHMER_RE = re.compile(r"[\u1780-\u17ff]")

#: Tesseract sometimes returns Khmer numerals where the card prints Latin 0-9.
_KHMER_DIGITS = str.maketrans("០១២៣៤៥៦៧៨៩", "0123456789")

#: A field whose own OCR words read below this confidence is captured but not
#: trustworthy: the UI marks it for the user to verify (D24). 60 sits between
#: the two readings a card gives — readable words land in the 60s and up, the
#: garbled ones in the 20s and below.
_UNCLEAR_CONFIDENCE = 60

#: English month names as `strptime`'s `%b` knows them, plus the full spellings
#: Tesseract sometimes returns instead.
_EN_MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

#: The month names a Khmer ID card prints beside the English ones. They are
#: rewritten to the English abbreviation before parsing, so one date routine
#: covers both scripts.
_KHMER_MONTHS = {
    "មករា": "jan",
    "កុម្ភៈ": "feb",
    "មីនា": "mar",
    "មេសា": "apr",
    "ឧសភា": "may",
    "មិថុនា": "jun",
    "កក្កដា": "jul",
    "សីហា": "aug",
    "កញ្ឆា": "sep",
    "តុលា": "oct",
    "វិច្ឆិកា": "nov",
    "ធ្នូ": "dec",
}


def _latinised(value: str) -> str:
    """Khmer numerals to Latin digits and Khmer months to their English names.

    One rewrite lets every routine below — the label scans as well as the
    date candidates — read dates printed in either script.
    """
    latin = value.translate(_KHMER_DIGITS)
    for khmer, abbr in sorted(_KHMER_MONTHS.items(), key=lambda item: -len(item[0])):
        latin = latin.replace(khmer, abbr)
    return latin


def _iso_date(day: str, month: int, year: str) -> str | None:
    parsed = int(year)
    if parsed < 100:
        parsed += 1900 if parsed >= 69 else 2000
    try:
        return datetime(parsed, month, int(day)).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _pure_khmer_word(token: str) -> bool:
    """A Khmer word OCR left intact: Khmer glyphs only, no digits or Latin.

    The noise on a garbled name line (`ឧ76`, `ais`) is exactly what must not
    reach a name field, and it is recognisable without knowing the language.
    """
    cleaned = token.strip(" ,.·:;!")
    return (
        bool(cleaned) and bool(_KHMER_RE.search(cleaned)) and not re.search(r"[\dA-Za-z]", cleaned)
    )


def _name_words(value: str | None) -> str | None:
    """Only the intact Khmer words survive of a name (D24).

    An NLP analysis that echoes the row's OCR noise must not land in a name
    slot; whatever it leaves here is what the merge may consider.
    """
    if not value:
        return None
    kept = [token for token in value.split() if _pure_khmer_word(token)]
    return " ".join(kept) or None


def _conf_key(token: str) -> str | None:
    """A comparable form of one word: Khmer digits normalised, noise stripped.

    Both sides of a comparison go through here — the parsed value (whose text
    already had Khmer digits translated) and the raw data-pass word — so
    `១៥` and `15` are the same key.
    """
    key = re.sub(r"[^\w]", "", token.translate(_KHMER_DIGITS), flags=re.UNICODE).lower()
    return key or None


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
        text, words = self._ocr_text(image_bytes)
        nlp = self._nlp.extract(text)
        rule = self._parse_id_card(text)
        identity = self._merge_rule_with_nlp(rule, nlp)
        return self._result(
            identity,
            required=_REQUIRED_ID_FIELDS,
            doc=DocumentType.KHMER_ID_CARD,
            unclear=self._unclear_fields(identity, words),
        )

    async def read_passport(self, image_bytes: bytes, *, media_type: str) -> OcrResult:
        text, words = self._ocr_text(image_bytes)
        nlp = self._nlp.extract(text)
        rule = self._parse_passport(text)
        identity = self._merge_rule_with_nlp(rule, nlp)
        return self._result(
            identity,
            required=_REQUIRED_PASSPORT_FIELDS,
            doc=DocumentType.PASSPORT,
            unclear=self._unclear_fields(identity, words),
        )

    # -- OCR ----------------------------------------------------------------

    def _ocr_text(self, image_bytes: bytes) -> tuple[str, list[tuple[str, int]]]:
        """The chosen pass's text plus its per-word confidences (D24).

        The data pass runs on the very image that produced the text, so every
        confidence belongs to a word the parse actually sees — the Khmer name
        line, for one, only survives in the binarized pass.
        """
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
            return str(threshold.translate(_KHMER_DIGITS)), self._word_confidences(bw)
        return str(clean.translate(_KHMER_DIGITS)), self._word_confidences(img)

    def _word_confidences(self, img: Image.Image) -> list[tuple[str, int]]:
        """`(word, confidence)` for every word Tesseract recognised.

        Missing confidences must not fail a read that otherwise succeeded:
        with none, no field can be marked unclear and the form falls back to
        prompting only for what was not read at all.
        """
        try:
            data = pytesseract.image_to_data(
                img, lang=self._languages, output_type=pytesseract.Output.DICT
            )
        except Exception:
            logger.info("tesseract data pass failed; field confidences unavailable")
            return []
        words: list[tuple[str, int]] = []
        for raw, conf in zip(data["text"], data["conf"], strict=False):
            if raw.strip() and int(conf) >= 0:
                words.append((raw, int(conf)))
        return words

    def _unclear_fields(
        self, identity: IdentityData, words: list[tuple[str, int]]
    ) -> tuple[str, ...]:
        """Fields whose own OCR words read below the confidence floor (D24).

        Only words the data pass actually recognised count: a value it has no
        word for (a normalised ISO date, say) has no confidence to report and
        is not blamed for that. One low word taints the whole field — the
        user is asked to verify a value only part of which the engine doubted.
        """
        if not words:
            return ()
        confidence: dict[str, int] = {}
        for word, conf in words:
            key = _conf_key(word)
            if key:
                confidence[key] = min(confidence.get(key, 100), conf)
        unclear: list[str] = []
        for name, value in identity.extracted_fields.items():
            matched = [
                confidence[key]
                for key in (_conf_key(token) for token in value.split())
                if key is not None and key in confidence
            ]
            if matched and min(matched) < _UNCLEAR_CONFIDENCE:
                unclear.append(name)
        return tuple(unclear)

    def _looks_khmer(self, value: str | None) -> bool:
        return bool(value) and _KHMER_RE.search(value or "") is not None

    def _merge_rule_with_nlp(self, rule: IdentityData, nlp: IdentityData | None) -> IdentityData:
        base = nlp or rule

        def _normalise_id(value: str | None) -> str | None:
            if not value:
                return None
            cleaned = re.sub(r"[\s\-/.,]", "", value).strip()
            return cleaned or None

        def _khmer_pair(
            first: str | None, last: str | None
        ) -> tuple[str | None, str | None] | None:
            if (
                first
                and last
                and first != last
                and self._looks_khmer(first)
                and self._looks_khmer(last)
            ):
                return first, last
            return None

        # The card prints both Khmer names on one line, so slot-by-slot mixing
        # is how a name gets duplicated or swapped. A complete pair from the
        # NLP analysis of that line wins (D24), then the rule's pair (label or
        # structural split), then whatever single side exists — never the same
        # word in both slots. Whatever the model echoes back, only intact
        # Khmer words may enter a name slot: an analysis repeating OCR noise
        # (`ឧ76`) is not an answer.
        nlp_first = _name_words(nlp.first_name_khmer) if nlp else None
        nlp_last = _name_words(nlp.last_name_khmer) if nlp else None
        pair = _khmer_pair(nlp_first, nlp_last)
        if pair is None:
            pair = _khmer_pair(rule.first_name_khmer, rule.last_name_khmer)
        if pair is not None:
            cand_first, cand_last = pair
        else:
            cand_first = nlp_first or rule.first_name_khmer
            cand_last = nlp_last or rule.last_name_khmer
            # A lone word cannot fill both slots.
            if cand_first and cand_first == cand_last:
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

        kh_first = self._khmer_field(text, ("នាមដំបូង", "ឈ្មោះដំបូង", "ឈ្មោះ"))
        kh_last = self._khmer_field(text, ("នាមត្រកូល", "ត្រកូល"))
        if kh_first is None or kh_last is None:
            # The card prints both Khmer names on one line (D24): when the
            # family label does not OCR, the line's own structure splits them.
            split_first, split_last = self._split_khmer_name(text)
            if split_first is not None or split_last is not None:
                kh_first, kh_last = split_first, split_last

        data = IdentityData(
            national_id=national_id,
            first_name_khmer=kh_first,
            last_name_khmer=kh_last,
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
            expiry_date=self._expiry_candidate(text)
            or self._label_value(
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
        self,
        identity: IdentityData,
        *,
        required: tuple[str, ...],
        doc: DocumentType,
        unclear: tuple[str, ...] = (),
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
            status=status,
            identity=identity,
            document_type=doc,
            missing_fields=missing,
            unclear_fields=unclear,
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

    def _split_khmer_name(self, text: str) -> tuple[str | None, str | None]:
        """Split the card's single Name line the way the card prints it.

        The Khmer ID prints `ឈ្មោះ/Name <given> <family>` as one run of words
        with no label between the two (D24), so when the family label does not
        OCR the structure itself is the evidence: keep only the pure-Khmer
        words, the last is the family name and the rest the given name. One
        Khmer word cannot say which half it is, so both slots stay empty for
        the user rather than guessing (§16).
        """
        for line in text.splitlines():
            label = re.search(r"ឈ្មោះ|\bname\b", line, re.IGNORECASE)
            if label is None:
                continue
            tokens = [
                cleaned
                for token in line[label.end() :].split()
                if _pure_khmer_word(token)
                for cleaned in [token.strip(" ,.·:;!")]
            ]
            if len(tokens) >= 2:
                return " ".join(tokens[:-1]), tokens[-1]
            if tokens:
                return None, None
        return None, None

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
        """Normalise any date rendering a card gives us to `YYYY-MM-DD`.

        Tesseract reads Cambodian card dates as `15/01/2022`, as `15 JAN 2022`
        (Latin month, as printed) and as Khmer numerals with a Khmer month
        (`១៥ មករា ២០២២`); all three reach here.
        """
        if not value:
            return None
        latin = _latinised(value)
        if re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}", latin):
            return latin
        match = _DATE_RE.search(latin)
        if not match:
            return None
        named = _NAMED_DATE_RE.fullmatch(match.group(1))
        if named:
            month = _EN_MONTHS.get(named.group(2).lower().rstrip("."))
            if month is None:
                return None
            return _iso_date(named.group(1), month, named.group(3))
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

    def _expiry_candidate(self, text: str) -> str | None:
        """Heuristic for the expiry date, tried before the label scan.

        Mirrors `_birth_candidate`. A card prints an issue date and, later, an
        expiry date — both well past the birth window — so with at least two
        distinct plausible dates the newest is the expiry. Tesseract sometimes
        jumbles the word "Expiry" onto the issue line, which makes the label
        scan pick the issue date; the newest-date rule is immune to that.
        A single plausible date could just be the issue date, so nothing is
        claimed and the field stays for the user to enter (§16: never guess).
        """
        plausible = {
            iso
            for m in _DATE_RE.finditer(text)
            if (iso := self._normalise_date(m.group(0))) and 2016 <= int(iso[:4]) <= 2100
        }
        return max(plausible) if len(plausible) >= 2 else None

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
