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
        prompt = (
            "You are an OCR field extractor. From the following OCR text of a Cambodian "
            "ID card / passport, return ONLY a JSON object with exactly these keys: "
            f"{', '.join(_FIELD_KEYS)}. Use null when a value is not present. Dates are "
            "usually DD-MM-YYYY or DD/MM/YYYY; convert each to YYYY-MM-DD. "
            "gender must be 'M' or 'F'.\n\nTEXT:\n" + text
        )
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
