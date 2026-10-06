"""NLP-based field extraction via a local Ollama model.

Given raw OCR text (Tesseract), a small local LLM maps the visible tokens onto the
nine identity fields. This is the *understanding* step (which token belongs to
which field) that keyword labels cannot do across styles. It never contacts
CamDX; it goes at a configurable local Ollama server.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.domain.models import IdentityData

logger = logging.getLogger("camdx.nlp")

_FIELD_KEYS = [
    "nationalId",
    "firstNameKhmer",
    "lastNameKhmer",
    "firstNameEnglish",
    "lastNameEnglish",
    "gender",
    "dateOfBirth",
    "issuedDate",
    "expiryDate",
]

_CARD_STYLE = """\
You are an OCR field extractor for a Cambodian National ID card (or passport).
The card's printed style, which the extracted text follows:

- Title: "KINGDOM OF CAMBODIA" / "KHMER NATIONAL IDENTITY CARD".
- Name row: the label "ឈ្មោះ/Name" (or "ឈ្មោះ"), then the holder's Khmer name as
  ONE run of words with the GIVEN NAME first and the FAMILY NAME last; the
  Latin line right beneath prints the same two names in the SAME order
  (GIVEN FAMILY). Split the Khmer run on that order: firstNameKhmer is
  everything up to the last Khmer word, lastNameKhmer is the last Khmer word.
  Any token in the run containing digits or Latin letters is OCR noise, not
  part of the name — drop it before splitting. Worked example: a run reading
  `<noise> WORD1 WORD2` yields firstNameKhmer="WORD1", lastNameKhmer="WORD2",
  never the noise token.
- Then rows for sex (ភេទ), date of birth (ថ្ងៃកំណើត), place of birth, address,
  date of issue and date of expiry, and a machine-readable zone at the bottom.
"""


def _prompt(text: str) -> str:
    """The extraction prompt: the JSON contract plus the card's name layout.

    The card prints the Khmer name as a single run — given then family — with
    no label between the two, so "which token is the family name" is exactly
    the understanding a keyword scan cannot do; the layout note is what makes
    the model answer it the way the card means it (D24).
    """
    return (
        _CARD_STYLE
        + "\nReturn ONLY a JSON object with exactly these keys: "
        + ", ".join(_FIELD_KEYS)
        + ". Use null when a value is not present. Dates are usually DD-MM-YYYY "
        "or DD/MM/YYYY (or the Khmer-numeral form); convert each to YYYY-MM-DD. "
        "gender must be 'M' or 'F'. Never invent a value that is not in the text."
        "\n\nTEXT:\n" + text
    )


class OllamaFieldExtractor:
    def __init__(self, *, base_url: str | None, model: str) -> None:
        self._base_url = (base_url or "").rstrip("/")
        self._model = model

    @property
    def available(self) -> bool:
        return bool(self._base_url)

    def extract(self, text: str) -> IdentityData | None:
        if not self._base_url:
            return None
        prompt = _prompt(text)
        try:
            resp = httpx.post(
                f"{self._base_url}/api/generate",
                json={
                    "model": self._model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0},
                },
                timeout=90,
            )
            resp.raise_for_status()
        except Exception as exc:
            logger.info("ollama call failed: %s", type(exc).__name__)
            return None
        try:
            payload = json.loads(resp.json().get("response", ""))
        except Exception:
            return None
        return self._to_identity(payload)

    def _to_identity(self, payload: dict[str, Any]) -> IdentityData | None:
        values: dict[str, str | None] = {}
        for key in _FIELD_KEYS:
            raw = payload.get(key)
            values[key] = raw.strip() if isinstance(raw, str) and raw.strip() else None
        if all(values[k] is None for k in _FIELD_KEYS):
            return None
        return IdentityData(
            national_id=values["nationalId"],
            first_name_khmer=values["firstNameKhmer"],
            last_name_khmer=values["lastNameKhmer"],
            first_name_english=values["firstNameEnglish"],
            last_name_english=values["lastNameEnglish"],
            gender=values["gender"],
            date_of_birth=self._date(values["dateOfBirth"]),
            issued_date=self._date(values["issuedDate"]),
            expiry_date=self._date(values["expiryDate"]),
        )

    def _date(self, value: str | None) -> str | None:
        if not value:
            return None
        from datetime import datetime

        for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%Y/%m/%d"):
            try:
                return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        return None
