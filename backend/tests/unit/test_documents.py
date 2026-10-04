"""ID-card processing orchestration (§12, §14, §15).

Two behaviours are worth protecting here, because both would be silent failures
rather than crashes:

* OCR and face detection are independent. Losing the portrait must not cost the
  user their identity fields, and vice versa.
* A failed request must not leave the uploaded card sitting in temp storage.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.errors import AppError, ErrorCode
from app.domain.enums import FaceExtractionStatus
from app.integrations.camdx.mock.ocr import MockOcrProvider
from app.services.artifacts import TempArtifactStore
from app.services.documents import DocumentProcessor
from app.services.face import FaceService
from tests.fixtures.detectors import NO_FACE, ONE_FACE, TWO_FACES
from tests.fixtures.images import card_without_face, textured_region_card

IMAGE = "image/jpeg"


@pytest.fixture
def store(tmp_path: Path) -> TempArtifactStore:
    return TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)


def processor_for(
    store: TempArtifactStore,
    detector: object,
    *,
    unreadable: bool = False,
) -> DocumentProcessor:
    return DocumentProcessor(
        ocr=MockOcrProvider(unreadable=unreadable),
        face=FaceService(store, detector),  # type: ignore[arg-type]
        store=store,
    )


def stored_handles(store: TempArtifactStore) -> list[str]:
    """Handles currently in the store, for asserting what was cleaned up."""
    return [path.name.removeprefix("artefact_") for path in store.root.iterdir()]


async def test_returns_identity_fields_and_a_processing_id(store: TempArtifactStore) -> None:
    result = await processor_for(store, ONE_FACE).process_id_card(
        textured_region_card(),
        media_type=IMAGE,
    )

    assert result.processing_id
    assert result.ocr.identity.national_id == "000000000000"
    assert result.ocr.document_type is not None


async def test_the_original_card_is_retained_for_display(store: TempArtifactStore) -> None:
    """§14 shows the uploaded card beside the extracted data, so it must persist."""
    processor = processor_for(store, ONE_FACE)
    payload = textured_region_card()

    result = await processor.process_id_card(payload, media_type=IMAGE)

    assert result.document_artefact_handle is not None
    assert store.read(result.document_artefact_handle) == payload


async def test_identity_fields_survive_a_missing_face(store: TempArtifactStore) -> None:
    """The two reads are independent; a bad portrait is not a failed submission."""
    result = await processor_for(store, NO_FACE).process_id_card(
        card_without_face(),
        media_type=IMAGE,
    )

    assert result.face.status is FaceExtractionStatus.NOT_DETECTED
    assert result.face.face_artefact_handle is None
    assert result.ocr.identity.national_id == "000000000000"


async def test_a_face_is_reported_even_when_ocr_only_read_part(store: TempArtifactStore) -> None:
    """Partial OCR plus a found portrait is a normal, reportable outcome."""
    result = await processor_for(store, ONE_FACE).process_id_card(
        textured_region_card(),
        media_type=IMAGE,
    )

    assert result.status == "partial"
    assert result.ocr.missing_fields == ("dateOfBirth",)
    assert result.face.status is FaceExtractionStatus.DETECTED


async def test_multiple_faces_are_reported_without_a_crop(store: TempArtifactStore) -> None:
    """§12: never guess which portrait is the user."""
    result = await processor_for(store, TWO_FACES).process_id_card(
        textured_region_card(),
        media_type=IMAGE,
    )

    assert result.face.status is FaceExtractionStatus.MULTIPLE
    assert result.face.detected_count == 2
    assert result.face.face_artefact_handle is None
    # The identity fields are still available to the user.
    assert result.ocr.identity.national_id == "000000000000"


async def test_an_unreadable_card_is_a_business_error(store: TempArtifactStore) -> None:
    with pytest.raises(AppError) as excinfo:
        await processor_for(store, ONE_FACE, unreadable=True).process_id_card(
            card_without_face(),
            media_type=IMAGE,
        )

    assert excinfo.value.code is ErrorCode.OCR_UNREADABLE


async def test_a_failed_request_does_not_leave_the_card_on_disk(store: TempArtifactStore) -> None:
    """Every rejected upload would otherwise keep a document for the full TTL."""
    with pytest.raises(AppError):
        await processor_for(store, ONE_FACE, unreadable=True).process_id_card(
            card_without_face(),
            media_type=IMAGE,
        )

    assert stored_handles(store) == []


async def test_no_image_bytes_appear_in_the_result(store: TempArtifactStore) -> None:
    """§29: handles cross the boundary, never payloads."""
    result = await processor_for(store, ONE_FACE).process_id_card(
        textured_region_card(),
        media_type=IMAGE,
    )

    for handle in (result.document_artefact_handle, result.face_artefact_handle):
        assert handle is None or isinstance(handle, str)
        assert handle.startswith("art_")


async def test_each_request_gets_its_own_processing_id(store: TempArtifactStore) -> None:
    processor = processor_for(store, ONE_FACE)

    first = await processor.process_id_card(textured_region_card(), media_type=IMAGE)
    second = await processor.process_id_card(textured_region_card(), media_type=IMAGE)

    assert first.processing_id != second.processing_id


async def test_a_stored_face_crop_is_jpeg_and_retrievable(store: TempArtifactStore) -> None:
    result = await processor_for(store, ONE_FACE).process_id_card(
        textured_region_card(),
        media_type=IMAGE,
    )

    handle = result.face.face_artefact_handle
    assert handle is not None
    artefact = store.get(handle)
    assert artefact.media_type == "image/jpeg"
    assert artefact.size_bytes > 0
