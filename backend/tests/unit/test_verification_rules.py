"""The §26 comparison and §25-§27 status rules, as pure data.

No I/O of any kind (testing rule 2): these are the rules every provider's
result passes through, so they are tested against plain dictionaries rather
than through HTTP.
"""

from __future__ import annotations

import pytest

from app.domain.enums import FieldCheckStatus, VerificationStatus
from app.domain.models import IdentityData
from app.domain.verification import compare_identity, derive_verification_status

#: A complete record: every §14 field present, unmistakably fake (§16).
RECORD = IdentityData(
    national_id="000000000000",
    first_name_khmer="\u1798\u17d2\u179a\u17b8\u1798\u17c1",
    last_name_khmer="\u179a\u17b7\u1794\u1780",
    first_name_english="SAMPLE",
    last_name_english="PERSON",
    date_of_birth="1992-07-18",
    gender="M",
    issued_date="2020-01-01",
    expiry_date="2030-01-01",
)

#: The same identity as a submitted form — the exact match case.
SUBMITTED = dict(RECORD.extracted_fields)


class TestCompareIdentity:
    def test_every_field_matches_a_held_record(self) -> None:
        statuses = compare_identity(SUBMITTED, RECORD)

        assert set(statuses.values()) == {FieldCheckStatus.MATCHED}

    def test_no_record_mismatches_every_field(self) -> None:
        """An unknown national ID is an unverifiable identity, not a partial one (§27)."""
        statuses = compare_identity(SUBMITTED, None)

        assert set(statuses.values()) == {FieldCheckStatus.MISMATCH}
        assert len(statuses) == 9

    def test_one_wrong_field_is_exactly_one_mismatch(self) -> None:
        statuses = compare_identity({**SUBMITTED, "dateOfBirth": "1999-01-01"}, RECORD)

        assert statuses["dateOfBirth"] is FieldCheckStatus.MISMATCH
        assert sum(1 for s in statuses.values() if s is FieldCheckStatus.MATCHED) == 8

    def test_a_field_the_record_does_not_hold_is_not_checked(self) -> None:
        """A comparison that never happened must not render as a failure (§25)."""
        record = IdentityData(national_id="123456789")  # nothing else stored
        statuses = compare_identity({**SUBMITTED, "nationalId": "123456789"}, record)

        assert statuses["nationalId"] is FieldCheckStatus.MATCHED
        assert statuses["firstNameKhmer"] is FieldCheckStatus.NOT_CHECKED
        assert FieldCheckStatus.MISMATCH not in statuses.values()

    @pytest.mark.parametrize(
        ("field", "submitted"),
        [
            ("firstNameEnglish", "sample"),  # case carries no meaning for a name
            ("lastNameEnglish", "  PERSON "),
            ("gender", "male"),  # spellings OCR and humans both produce
            ("gender", " m "),
        ],
    )
    def test_accepted_variants_compare_equal(self, field: str, submitted: str) -> None:
        statuses = compare_identity({**SUBMITTED, field: submitted}, RECORD)

        assert statuses[field] is FieldCheckStatus.MATCHED

    def test_gender_words_are_not_equality_matches(self) -> None:
        """`male` and `female` both canonicalise — to different letters."""
        statuses = compare_identity({**SUBMITTED, "gender": "female"}, RECORD)

        assert statuses["gender"] is FieldCheckStatus.MISMATCH

    @pytest.mark.parametrize(("submitted", "expected"), [("000000000000", True), ("0", False)])
    def test_national_ids_compare_as_strings(self, submitted: str, expected: bool) -> None:
        """Leading zeros are part of the ID; integer coercion would conflate people."""
        statuses = compare_identity({**SUBMITTED, "nationalId": submitted}, RECORD)

        assert (statuses["nationalId"] is FieldCheckStatus.MATCHED) is expected

    def test_dates_compare_exactly(self) -> None:
        statuses = compare_identity({**SUBMITTED, "dateOfBirth": "1992-7-18"}, RECORD)

        assert statuses["dateOfBirth"] is FieldCheckStatus.MISMATCH


def _statuses(**overrides: str) -> dict[str, FieldCheckStatus]:
    """Nine `matched` fields with the named ones replaced — a shaped input."""
    base = dict.fromkeys(
        (
            "nationalId",
            "firstNameKhmer",
            "lastNameKhmer",
            "firstNameEnglish",
            "lastNameEnglish",
            "gender",
            "dateOfBirth",
            "issuedDate",
            "expiryDate",
        ),
        FieldCheckStatus.MATCHED,
    )
    for name, value in overrides.items():
        base[name] = FieldCheckStatus(value)
    return base


class TestDeriveVerificationStatus:
    @pytest.mark.parametrize(
        ("sections", "expected"),
        [
            ([], VerificationStatus.SUCCESS),  # API 1: no optional sections
            ([True], VerificationStatus.SUCCESS),
            ([True, True], VerificationStatus.SUCCESS),
            ([False], VerificationStatus.PARTIAL),
            ([None], VerificationStatus.PARTIAL),  # required but unanswered
            ([True, False], VerificationStatus.PARTIAL),
        ],
    )
    def test_sections_shape_the_status_when_identity_matches(
        self, sections: list[bool | None], expected: VerificationStatus
    ) -> None:
        assert derive_verification_status(_statuses(), sections=sections) is expected

    def test_one_mismatch_is_partial_not_failed(self) -> None:
        """§26: a report that can say which fields matched may not say "failed"."""
        status = derive_verification_status(_statuses(dateOfBirth="mismatch"), sections=[])

        assert status is VerificationStatus.PARTIAL

    def test_nothing_matching_is_failed(self) -> None:
        statuses = dict.fromkeys(_statuses(), FieldCheckStatus.MISMATCH)

        assert derive_verification_status(statuses, sections=[]) is VerificationStatus.FAILED

    def test_failed_wins_over_a_passing_section(self) -> None:
        statuses = dict.fromkeys(_statuses(), FieldCheckStatus.MISMATCH)

        assert derive_verification_status(statuses, sections=[True]) is VerificationStatus.FAILED

    def test_not_checked_neither_passes_nor_fails(self) -> None:
        """An unchecked field must not block success — or claim to be matched."""
        statuses = _statuses(dateOfBirth="not_checked")
        status = derive_verification_status(statuses, sections=[True])

        assert status is VerificationStatus.SUCCESS
