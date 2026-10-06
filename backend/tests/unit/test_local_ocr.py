"""Local OCR parsing: dates as cards and Tesseract actually render them.

Tesseract reads Cambodian ID card dates as `15/01/2022`, as `15 JAN 2022`
(month in Latin letters, as printed) and as Khmer numerals with a Khmer month
(`១៥ មករា ២០២២`). The parser must return the same `YYYY-MM-DD` for all
three, or §16's prompt for the user turns into an empty field that was in
fact read — the bug this file pins down.
"""

from __future__ import annotations

import pytest

from app.domain.models import IdentityData
from app.services.local_ocr import LocalTesseractOcrProvider

#: Lines as Tesseract returned them for a real card upload (trimmed to the
#: date-bearing ones; the full image output also carries address and MRZ lines
#: that contribute no dates).
CARD_TEXT = """\
tfig/Sex ប្រុស/|/ ០៥ ធ្ន ១៩៨៨
ថ្ងៃខៃឆ្នាំកំណើត/8(9 of Birth 05 DEC 1988
igtomung/Date of Issue ១៥ មករា ២០២២
១៥ JAN ២០២២
15 JAN 2022 Director General

15 JAN 2032 .
"""


@pytest.fixture
def provider() -> LocalTesseractOcrProvider:
    return LocalTesseractOcrProvider()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("15/01/2022", "2022-01-15"),
        ("15-01-2022", "2022-01-15"),
        ("15 JAN 2022", "2022-01-15"),
        ("05 DEC 1988", "1988-12-05"),
        ("05 dec 1988", "1988-12-05"),
        ("15 Sept 2032", "2032-09-15"),
        ("15 JAN 2022 Director General", "2022-01-15"),
        ("15 JAN 2032 .", "2032-01-15"),
        ("១៥ មករា ២០២២", "2022-01-15"),
        ("hello", None),
        ("31 FEB 2022", None),
    ],
)
def test_normalise_date_accepts_every_rendering_the_card_prints(
    provider: LocalTesseractOcrProvider, raw: str, expected: str | None
) -> None:
    assert provider._normalise_date(raw) == expected


def test_id_card_dates_fill_from_the_lines_tesseract_reads(
    provider: LocalTesseractOcrProvider,
) -> None:
    """The card's three dates must all land, each from the right line.

    Before this, `05 DEC 1988` and the Khmer issue line matched no format at
    all, so the form prompted for values the OCR had read — and the expiry
    label missing from the OCR output claimed nothing even when the date
    itself was on the page.
    """
    data = provider._parse_id_card(CARD_TEXT)

    assert data.date_of_birth == "1988-12-05"
    assert data.issued_date == "2022-01-15"
    assert data.expiry_date == "2032-01-15"


def test_expiry_candidate_takes_the_newest_of_two_later_dates(
    provider: LocalTesseractOcrProvider,
) -> None:
    text = "05 DEC 1988\n15 JAN 2022\n15 JAN 2032"

    assert provider._expiry_candidate(text) == "2032-01-15"


def test_expiry_candidate_claims_nothing_from_a_single_later_date(
    provider: LocalTesseractOcrProvider,
) -> None:
    """One later date may be the issue date alone; claiming it would be a guess (§16)."""
    assert provider._expiry_candidate("05 DEC 1988\n15 JAN 2022") is None


def test_expiry_candidate_claims_nothing_birth_era_dates_only(
    provider: LocalTesseractOcrProvider,
) -> None:
    assert provider._expiry_candidate("05 DEC 1988") is None


def test_expiry_prefers_the_newest_date_when_tesseract_jumbles_the_label(
    provider: LocalTesseractOcrProvider,
) -> None:
    """`Expiry` landing on the issue line must not make the issue date the expiry."""
    text = (
        "igtomunyy/Date of Issue 15 មករា 2022 Sf enn Gomer Expiry,\n"
        "15 JAN 2022 Director General 15 JAN 2032\n"
    )

    assert provider._parse_id_card(text).expiry_date == "2032-01-15"


def test_birth_candidate_still_earliest_when_named_months_present(
    provider: LocalTesseractOcrProvider,
) -> None:
    assert provider._birth_candidate("15 JAN 2032\n05 DEC 1988\n15 JAN 2022") == "1988-12-05"


def test_the_name_line_splits_into_given_and_family_per_the_card_style(
    provider: LocalTesseractOcrProvider,
) -> None:
    """The card prints `ឈ្មោះ/Name <given> <family>` as one run (D24).

    The family label never OCRs on this card, so the line's own order — the
    same one the Latin line beneath prints — is what separates the two names,
    and the digit noise in the run must not reach either slot.
    """
    data = provider._parse_id_card("ឈ្មោះ//ខកា6 ភាររីន ឈីន\nPHEARAEUN CHHEUN")

    assert data.first_name_khmer == "ភាររីន"
    assert data.last_name_khmer == "ឈីន"


def test_a_single_khmer_word_cannot_fill_both_name_slots(
    provider: LocalTesseractOcrProvider,
) -> None:
    """One surviving word could be either half — leave both for the user (§16)."""
    assert provider._split_khmer_name("ឈ្មោះ///ឧ76 ភាររីន ais") == (None, None)


def test_no_name_line_yields_no_khmer_names(
    provider: LocalTesseractOcrProvider,
) -> None:
    assert provider._split_khmer_name("KHMER NATIONAL IDENTITY CARD") == (None, None)


def test_a_complete_nlp_pair_wins_over_the_rule_read(
    provider: LocalTesseractOcrProvider,
) -> None:
    """The analysis of the whole Name line is the answer the rule could not give."""
    rule = IdentityData(first_name_khmer="ភាររីន", last_name_khmer="ឈីន")
    nlp = IdentityData(first_name_khmer="ចម", last_name_khmer="សុខ")

    merged = provider._merge_rule_with_nlp(rule, nlp)

    assert (merged.first_name_khmer, merged.last_name_khmer) == ("ចម", "សុខ")


def test_nlp_echoing_ocr_noise_does_not_reach_a_name_slot(
    provider: LocalTesseractOcrProvider,
) -> None:
    """An analysis repeating the row's noise is not an answer; the rule stands."""
    rule = IdentityData(first_name_khmer="ភាររីន", last_name_khmer="ឈីន")
    nlp = IdentityData(first_name_khmer="ឧ76", last_name_khmer="ភាររីន")

    merged = provider._merge_rule_with_nlp(rule, nlp)

    assert (merged.first_name_khmer, merged.last_name_khmer) == ("ភាររីន", "ឈីន")


def test_the_rule_pair_survives_without_nlp(
    provider: LocalTesseractOcrProvider,
) -> None:
    rule = IdentityData(first_name_khmer="សុខា", last_name_khmer="ចម")

    merged = provider._merge_rule_with_nlp(rule, None)

    assert (merged.first_name_khmer, merged.last_name_khmer) == ("សុខា", "ចម")


def test_low_confidence_words_mark_the_field_for_verification(
    provider: LocalTesseractOcrProvider,
) -> None:
    identity = IdentityData(first_name_khmer="ភាររីន", last_name_khmer="ឈីន")
    words = [("ភាររីន", 89), ("ឈីន", 26), ("PHEARAEUN", 92)]

    assert provider._unclear_fields(identity, words) == ("lastNameKhmer",)


def test_a_field_the_data_pass_never_saw_is_not_blamed(
    provider: LocalTesseractOcrProvider,
) -> None:
    """A normalised ISO date has no word of its own to report a confidence for."""
    identity = IdentityData(date_of_birth="1988-12-05")
    words = [("05", 96), ("DEC", 96), ("1988", 19)]

    assert provider._unclear_fields(identity, words) == ()


def test_no_confidences_means_nothing_is_marked_unclear(
    provider: LocalTesseractOcrProvider,
) -> None:
    identity = IdentityData(last_name_khmer="ឈីន")

    assert provider._unclear_fields(identity, []) == ()
