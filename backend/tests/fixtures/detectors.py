"""A `FaceDetector` that returns boxes from a fixed script.

Face *rules* (no face → not detected, two → multiple, tiny → low quality, clear →
crop and store) are decided by `FaceService` from what a detector reports. Testing
them through a scripted detector keeps those tests independent of the Haar
cascade, whose behaviour depends on OpenCV's version and on statistics trained on
real faces — neither of which is what these tests are about.

A single integration test still exercises the real cascade, to prove the wiring
works rather than to assert on a drawing's pixel values.
"""

from __future__ import annotations

from typing import Any

from app.domain.models import FaceBox
from app.services.face import FaceDetector


class StubFaceDetector(FaceDetector):
    """Returns a predetermined list of boxes, ignoring the image."""

    def __init__(self, boxes: list[FaceBox] | None) -> None:
        self._boxes = boxes or []
        self.calls = 0

    def detect_boxes(self, image: Any) -> list[FaceBox]:
        self.calls += 1
        return list(self._boxes)


def detector_returning(*boxes: FaceBox) -> StubFaceDetector:
    """A detector that always finds exactly these boxes."""
    return StubFaceDetector(list(boxes))


def box(x: int = 200, y: int = 150, width: int = 120, height: int = 140) -> FaceBox:
    """A conveniently-sized face box."""
    return FaceBox(x=x, y=y, width=width, height=height)


NO_FACE = detector_returning()
ONE_FACE = detector_returning(box())
TWO_FACES = detector_returning(box(80, 150), box(420, 150))
