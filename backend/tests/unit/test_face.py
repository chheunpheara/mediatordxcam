"""Face extraction rules (§12, §13).

The rules are exercised through a scripted detector so they stay deterministic.
Two invariants are asserted explicitly because they are the ones most likely to be
broken by a well-meaning later change:

* Detection is never a verification (§13).
* An unreadable or absent face is reported honestly rather than faked.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.domain.enums import FaceExtractionStatus, FaceSource
from app.services.artifacts import TempArtifactStore
from app.services.face import FaceService, clamp_box
from tests.fixtures.detectors import NO_FACE, ONE_FACE, TWO_FACES, box, detector_returning
from tests.fixtures.images import (
    card_without_face,
    not_an_image,
    textured_region_card,
)


@pytest.fixture
def store(tmp_path: Path) -> TempArtifactStore:
    return TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)


def test_reports_no_face_when_the_detector_finds_nothing(store: TempArtifactStore) -> None:
    result = FaceService(store, NO_FACE).detect(card_without_face())

    assert result.status is FaceExtractionStatus.NOT_DETECTED
    assert result.detected_count == 0
    assert result.face_artefact_handle is None


def test_refuses_to_guess_when_several_faces_are_present(store: TempArtifactStore) -> None:
    """§12 requires a specific message, so no crop may be chosen arbitrarily."""
    result = FaceService(store, TWO_FACES).detect(card_without_face())

    assert result.status is FaceExtractionStatus.MULTIPLE
    assert result.detected_count == 2
    assert result.face_artefact_handle is None


def test_extracts_and_stores_a_single_face(store: TempArtifactStore) -> None:
    result = FaceService(store, ONE_FACE).detect(textured_region_card())

    assert result.status is FaceExtractionStatus.DETECTED
    assert result.detected_count == 1
    assert result.face_artefact_handle is not None
    # The crop must be retrievable through the store, not returned inline.
    assert store.read(result.face_artefact_handle)


def test_a_flat_crop_is_reported_as_low_quality(store: TempArtifactStore) -> None:
    """A uniform region has no detail; reporting it as a face would be a lie."""
    result = FaceService(store, ONE_FACE).detect(card_without_face())

    assert result.quality is not None
    assert result.status is FaceExtractionStatus.LOW_QUALITY
    assert result.face_artefact_handle is None


def test_tiny_faces_are_rejected_before_cropping(store: TempArtifactStore) -> None:
    tiny = detector_returning(box(width=12, height=12))
    result = FaceService(store, tiny).detect(card_without_face())

    assert result.status is FaceExtractionStatus.LOW_QUALITY
    assert result.face_artefact_handle is None


def test_undecodable_bytes_report_no_face_rather_than_raising(store: TempArtifactStore) -> None:
    result = FaceService(store, ONE_FACE).detect(not_an_image())

    assert result.status is FaceExtractionStatus.NOT_DETECTED
    assert result.face_artefact_handle is None


def test_detection_is_never_labelled_as_verification(store: TempArtifactStore) -> None:
    """§13: the source is fixed, so a local crop cannot be read as KYC."""
    result = FaceService(store, ONE_FACE).detect(textured_region_card())

    assert result.source is FaceSource.LOCAL_DETECTION
    assert result.source is not FaceSource.CAMDX
    # A detection has no notion of a match, so it carries no such field at all.
    assert not hasattr(result, "verified")
    assert not hasattr(result, "score")


def test_the_face_image_is_never_returned_from_the_service(store: TempArtifactStore) -> None:
    """§29: only an opaque handle crosses the boundary."""
    result = FaceService(store, ONE_FACE).detect(textured_region_card())

    assert isinstance(result.face_artefact_handle, str)
    assert result.face_artefact_handle.startswith("art_")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ((0, 0, 100, 100), (0, 0, 100, 100)),
        ((790, 590, 100, 100), (790, 590, 10, 10)),
        ((-20, -20, 50, 50), (0, 0, 50, 50)),
    ],
)
def test_boxes_are_clamped_to_the_image(
    raw: tuple[int, int, int, int],
    expected: tuple[int, int, int, int],
) -> None:
    clamped = clamp_box(raw, width=800, height=600)
    assert (clamped.x, clamped.y, clamped.width, clamped.height) == expected


def test_real_cascade_runs_and_returns_a_valid_outcome(
    store: TempArtifactStore,
    face_card_bytes: bytes,
) -> None:
    """Integration check for the OpenCV wiring.

    Asserts only that a valid outcome comes back — *not* how many faces were
    found. That number belongs to the cascade shipped with the installed OpenCV,
    not to this application, and pinning it would make the suite fail on a
    dependency upgrade.
    """
    result = FaceService(store).detect(face_card_bytes)

    assert result.status in set(FaceExtractionStatus)
    assert result.source is FaceSource.LOCAL_DETECTION
    if result.status is FaceExtractionStatus.DETECTED:
        assert result.face_artefact_handle is not None
