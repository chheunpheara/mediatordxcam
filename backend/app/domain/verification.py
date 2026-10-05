"""Verification rules: record comparison and the overall status (§26, §27).

Two pure functions, no I/O:

* `compare_identity` — the status of each submitted §14 field against a stored
  record. This is what turns "the registry says X" into the per-field
  `matched` / `mismatch` / `not_checked` rows §26 renders.
* `derive_verification_status` — the §25-§27 rule for the overall status, given
  the field statuses and the required-section results.

They live in the domain rather than in a provider because they are product
rules, not adapter behaviour: the fixture provider and the database registry
must agree on what "matched" means, and a real CamDigiKey adapter maps its
response onto these same three states (§23). Nothing here touches a database,
a vendor payload or the network, so both rules are unit-tested as plain data.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from app.domain.enums import FieldCheckStatus, VerificationStatus
from app.domain.models import IdentityData
from app.domain.requirements import IDENTITY_FIELD_NAMES

#: Latin-script name fields where capitalisation carries no meaning for a match.
#: OCR, the printed card and a re-typed form can legitimately differ in case
#: ("SAMPLE" vs "sample"), and failing a user for typing their own name in a
#: different case would be a mismatch nobody can act on.
_CASE_INSENSITIVE_FIELDS = frozenset({"firstNameEnglish", "lastNameEnglish"})

#: Accepted spellings of gender, canonicalised to the single letter the OCR
#: pipeline emits (`services/local_ocr.py` coerces to "M"/"F" and accepts the
#: same Khmer words), so a form filled by OCR and a form typed by hand compare
#: equal.
_GENDER_ALIASES = {
    "m": "m",
    "male": "m",
    "f": "f",
    "female": "f",
    "\u1794\u17d2\u179a\u17bb\u179f": "m",  # Khmer "male", as OCR emits it
    "\u179f\u17d2\u179a\u17b8": "f",  # Khmer "female", as OCR emits it
}


def compare_identity(
    submitted: Mapping[str, str],
    record: IdentityData | None,
) -> dict[str, FieldCheckStatus]:
    """Status of every §14 field against one stored record (§26).

    * No record (`None`) → every field is a mismatch: an unknown national ID is
      not a partial match, it is an identity that could not be verified (§27).
    * A field the record does not hold (`None`) → `not_checked`: the registry
      never compared it, and §25 forbids presenting an unchecked field as
      anything other than unchecked.
    * Otherwise the two normalised strings compare for equality.

    National IDs compare as strings, never numbers: leading zeros are part of
    the number on the card, so integer coercion would silently equate two
    different people.
    """
    if record is None:
        return dict.fromkeys(IDENTITY_FIELD_NAMES, FieldCheckStatus.MISMATCH)

    stored = record.extracted_fields
    statuses: dict[str, FieldCheckStatus] = {}
    for name in IDENTITY_FIELD_NAMES:
        expected = stored.get(name)
        if expected is None:
            statuses[name] = FieldCheckStatus.NOT_CHECKED
            continue
        equal = _normalise(name, submitted.get(name, "")) == _normalise(name, expected)
        statuses[name] = FieldCheckStatus.MATCHED if equal else FieldCheckStatus.MISMATCH
    return statuses


def derive_verification_status(
    field_statuses: Mapping[str, FieldCheckStatus],
    *,
    sections: Iterable[bool | None],
) -> VerificationStatus:
    """Overall status from field results and required-section results (§25-§27).

    `sections` holds only the sections the method requires, `None` meaning the
    section could not be answered.

    * No identity field matched → `failed`: there is nothing useful to report
      (§27). An unknown national ID lands here.
    * Some fields mismatched while anything else passed → `partial`: §26
      explicitly forbids answering a report that could say "✓ National ID
      matched" with a flat "Verification Failed".
    * A required section that failed or could not be answered → `partial`, the
      rule the service layer has always applied; a negative verification is a
      result, not an HTTP error (§28).
    * Otherwise → `success`. `not_checked` fields are neither pass nor failure.
    """
    matched = sum(1 for status in field_statuses.values() if status is FieldCheckStatus.MATCHED)
    mismatched = sum(1 for status in field_statuses.values() if status is FieldCheckStatus.MISMATCH)
    parts = list(sections)

    if mismatched and not matched:
        return VerificationStatus.FAILED
    if mismatched or any(part is not True for part in parts):
        return VerificationStatus.PARTIAL
    return VerificationStatus.SUCCESS


def _normalise(name: str, value: str) -> str:
    """Canonical form of one field before comparison.

    Only what the data actually allows varies: whitespace everywhere, case for
    Latin names, spelling for gender. Dates stay exact — the form's datepicker
    and OCR both produce `YYYY-MM-DD`, and a fuzzy date match would be a
    comparison rule nobody asked for.
    """
    value = value.strip()
    if name in _CASE_INSENSITIVE_FIELDS:
        return value.casefold()
    if name == "gender":
        token = value.casefold()
        return _GENDER_ALIASES.get(token, token)
    return value
