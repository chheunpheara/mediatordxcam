"""OCR provider behaviour and the mock's honesty guarantees.

The mock exists so the flow can run offline, so its correctness matters in a
specific way: it must be unmistakably fake and it must not claim more than it
read. §16 calls out both traps — plausible-looking identity data, and a status
that disagrees with the fields actually returned.
"""

from __future__ import annotations

import pytest

from app.domain.enums import DocumentType, OcrStatus
from app.integrations.camdx.mock.ocr import MockOcrProvider
from tests.fixtures.images import card_without_face, not_an_image

IMAGE = "image/jpeg"


@pytest.fixture
def provider() -> MockOcrProvider:
    return MockOcrProvider()


async def test_reads_the_expected_id_card_fields(provider: MockOcrProvider) -> None:
    result = await provider.read_id_card(card_without_face(), media_type=IMAGE)

    assert result.identity.national_id == "000000000000"
    assert result.identity.first_name_english == "SAMPLE"
    assert result.identity.first_name_khmer
    assert result.document_type is DocumentType.KHMER_ID_CARD


async def test_fixture_data_is_unmistakably_fake(provider: MockOcrProvider) -> None:
    """§16: a reader must be able to tell a fixture from a real government read."""
    result = await provider.read_id_card(card_without_face(), media_type=IMAGE)

    assert result.identity.national_id == "000000000000"
    assert "SAMPLE" in {result.identity.first_name_english, result.identity.last_name_english}
    assert "SAMPLE ADDRESS" not in result.identity.extracted_fields.values()


async def test_a_missing_field_forces_a_partial_status(provider: MockOcrProvider) -> None:
    """The status must agree with `missing_fields`, or the UI trusts a lie.

    Mock OCR omits date of birth on purpose, so this is the default path: a result
    claiming `completed` while listing a missing field would let the user submit
    an incomplete form believing it was complete.
    """
    result = await provider.read_id_card(card_without_face(), media_type=IMAGE)

    assert "dateOfBirth" in result.missing_fields
    assert result.status == OcrStatus.PARTIAL.value
    assert result.status != OcrStatus.COMPLETED.value
    assert result.is_usable


async def test_a_fully_read_card_is_completed() -> None:
    """Passport mock omits no required field, so it must not report a gap."""
    provider = MockOcrProvider()
    result = await provider.read_passport(card_without_face(), media_type=IMAGE)

    assert result.missing_fields == ()
    assert result.status == OcrStatus.COMPLETED.value


async def test_an_optional_absent_field_is_not_reported_as_missing() -> None:
    """A passport is romanised, so absent Khmer names are not a gap.

    §14 puts all nine fields on the form, but §16 only makes the user chase a
    field the document was actually expected to carry. Asking for Khmer names on
    a passport would put two rows on screen they can never satisfy.
    """
    provider = MockOcrProvider()
    result = await provider.read_passport(card_without_face(), media_type=IMAGE)

    assert result.identity.first_name_khmer is None
    assert "firstNameKhmer" not in result.missing_fields


@pytest.mark.parametrize("read", ["read_id_card", "read_passport"])
async def test_an_unreadable_card_reports_nothing_as_read(read: str) -> None:
    """§15: an unreadable card is a business error, not an empty form.

    `is_usable` is what the orchestrator checks, so a blank result must not look
    like a partial success.
    """
    provider = MockOcrProvider(unreadable=True)
    result = await getattr(provider, read)(card_without_face(), media_type=IMAGE)

    assert result.status == OcrStatus.UNREADABLE.value
    assert result.is_usable is False
    assert result.identity.is_empty


async def test_the_result_is_deterministic(provider: MockOcrProvider) -> None:
    """The mock is a fixture; two reads of the same input must agree."""
    first = await provider.read_id_card(card_without_face(), media_type=IMAGE)
    second = await provider.read_id_card(card_without_face(), media_type=IMAGE)

    assert first.identity == second.identity
    assert first.missing_fields == second.missing_fields
    assert first.status == second.status


async def test_unreadable_bytes_do_not_crash_the_provider(provider: MockOcrProvider) -> None:
    """Validation happens upstream; the provider must not add a second failure mode."""
    result = await provider.read_id_card(not_an_image(), media_type=IMAGE)

    assert result.status in {OcrStatus.COMPLETED.value, OcrStatus.PARTIAL.value}


async def test_the_provider_name_is_reported(provider: MockOcrProvider) -> None:
    """The mode is surfaced so a response can be attributed to a fixture."""
    assert provider.name == "mock"
