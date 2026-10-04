"""Local face detection and extraction (§12).

OpenCV's job ends at "there is a face in this picture, here it is". It is never
a verification: nothing here compares the card face against anything, and
`FaceDetection.source` is fixed to `local_opencv_detection` so the distinction is
structural rather than a matter of care at the call site (§13).

`FaceDetector` is an interface so the *rules* — one face only, clear enough to be
worth using, crop it and store it — are testable without a photograph. The Haar
cascade is a statistical detector on real faces: it is scale-sensitive and its
output moves with OpenCV's version, so assertions about what it finds in a
synthetic drawing would be tests of the cascade, not of our logic.
"""

from __future__ import annotations

import abc
import logging
from typing import TYPE_CHECKING, Any

from app.domain.enums import FaceExtractionStatus
from app.domain.models import FaceBox, FaceDetection

if TYPE_CHECKING:  # pragma: no cover
    from app.services.artifacts import TempArtifactStore

logger = logging.getLogger("camdx.face")

#: A detected face smaller than this (longest side, px) is too small to use and
#: is reported as low quality rather than silently returned.
MIN_FACE_SIDE_PX = 40

#: Below this Laplacian variance a crop is too flat or blurry to be worth showing.
#: This is a clarity measure of the crop, never a match or similarity score.
MIN_QUALITY = 0.20

#: Cascade parameters. `minNeighbors=5` is deliberately strict: a permissive value
#: fires on texture in a background photo, and a false positive here would show the
#: user a crop of something that is not their face.
SCALE_FACTOR = 1.1
MIN_NEIGHBORS = 5


class FaceDetector(abc.ABC):
    """Finds candidate faces in a decoded image."""

    @abc.abstractmethod
    def detect_boxes(self, image: Any) -> list[FaceBox]:
        """Return every face box found, largest-first is not required."""


class HaarFaceDetector(FaceDetector):
    """OpenCV Haar cascade for frontal faces."""

    def __init__(self) -> None:
        self._cascade: Any | None = None

    def detect_boxes(self, image: Any) -> list[FaceBox]:
        """Run the cascade over an equalised grayscale copy of `image`."""
        cv2 = import_cv2()
        if cv2 is None:
            logger.warning("opencv unavailable; face detection disabled")
            return []
        cascade = self._load(cv2)
        if cascade is None:
            return []

        height, width = image.shape[:2]
        gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
        found = cascade.detectMultiScale(
            gray,
            scaleFactor=SCALE_FACTOR,
            minNeighbors=MIN_NEIGHBORS,
            minSize=(MIN_FACE_SIDE_PX, MIN_FACE_SIDE_PX),
        )
        return [clamp_box(_as_box(raw), width, height) for raw in found]

    def _load(self, cv2: Any) -> Any | None:
        """Load the bundled cascade once, tolerating a missing file."""
        if self._cascade is not None:
            return self._cascade
        from pathlib import Path

        path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        if not path.exists():
            logger.error("haar cascade missing from opencv package", extra={"path": str(path)})
            return None
        cascade = cv2.CascadeClassifier(str(path))
        if cascade.empty():
            logger.error("haar cascade failed to load")
            return None
        self._cascade = cascade
        return cascade


class FaceService:
    """Applies the face rules to whatever a `FaceDetector` reports."""

    def __init__(self, store: TempArtifactStore, detector: FaceDetector | None = None) -> None:
        self._store = store
        self._detector = detector or HaarFaceDetector()

    def detect(self, image_bytes: bytes) -> FaceDetection:
        """Detect a face in an ID-card image.

        Returns a result for every outcome rather than raising: "no face" and "two
        faces" are ordinary results of running a detector, and the caller decides
        which is worth surfacing to the user (§12 defines a message for each).
        """
        image = self._decode(image_bytes)
        if image is None:
            return FaceDetection(status=FaceExtractionStatus.NOT_DETECTED, detected_count=0)

        boxes = self._detector.detect_boxes(image)
        if not boxes:
            return FaceDetection(status=FaceExtractionStatus.NOT_DETECTED, detected_count=0)
        if len(boxes) > 1:
            # §12 gives an explicit message; do not guess which is the portrait.
            return FaceDetection(
                status=FaceExtractionStatus.MULTIPLE,
                detected_count=len(boxes),
            )

        box = boxes[0]
        if min(box.width, box.height) < MIN_FACE_SIDE_PX:
            return FaceDetection(
                status=FaceExtractionStatus.LOW_QUALITY,
                box=box,
                detected_count=1,
            )

        quality = self._quality(image, box)
        if quality < MIN_QUALITY:
            return FaceDetection(
                status=FaceExtractionStatus.LOW_QUALITY,
                box=box,
                quality=quality,
                detected_count=1,
            )

        encoded = self._encode(self._crop(image, box))
        if encoded is None:
            return FaceDetection(
                status=FaceExtractionStatus.LOW_QUALITY,
                box=box,
                detected_count=1,
            )

        artefact = self._store.put(encoded, media_type="image/jpeg")
        # The handle is logged; the image is not (§29).
        logger.info(
            "face extracted",
            extra={"handle": artefact.handle, "width": box.width, "height": box.height},
        )
        return FaceDetection(
            status=FaceExtractionStatus.DETECTED,
            box=box,
            face_artefact_handle=artefact.handle,
            quality=quality,
            detected_count=1,
        )

    def _decode(self, image_bytes: bytes) -> Any:
        """Decode bytes to a BGR array, or None when they are not an image."""
        cv2 = import_cv2()
        if cv2 is None:
            return None
        import numpy as np

        buffer: Any = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        if image is None or image.size == 0:
            return None
        return image

    def _quality(self, image: Any, box: FaceBox) -> float:
        """Variance of the Laplacian over the crop: a sharpness proxy."""
        cv2 = import_cv2()
        crop = image[box.y : box.y + box.height, box.x : box.x + box.width]
        if cv2 is None or crop.size == 0:
            return 0.0
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    def _crop(self, image: Any, box: FaceBox) -> Any:
        """Crop the region with a small margin, resized for display."""
        cv2 = import_cv2()
        pad = max(4, int(0.1 * max(box.width, box.height)))
        x0 = max(0, box.x - pad)
        y0 = max(0, box.y - pad)
        x1 = min(image.shape[1], box.x + box.width + pad)
        y1 = min(image.shape[0], box.y + box.height + pad)
        crop = image[y0:y1, x0:x1]
        if cv2 is not None and crop.size:
            crop = cv2.resize(crop, (160, 160), interpolation=cv2.INTER_AREA)
        return crop

    def _encode(self, crop: Any) -> bytes | None:
        """Encode a crop as JPEG bytes."""
        cv2 = import_cv2()
        if cv2 is None or not getattr(crop, "size", 0):
            return None
        ok, encoded = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        return encoded.tobytes() if ok else None


def _as_box(raw: Any) -> tuple[int, int, int, int]:
    """Normalise a detector result to `(x, y, width, height)` integers.

    OpenCV returns NumPy integers and, depending on the overload, a 4-tuple or a
    nested one. Normalising here keeps the arithmetic downstream ordinary Python.
    """
    values = [int(v) for v in raw]
    if len(values) != 4:
        raise ValueError(f"expected a 4-value face box, got {len(values)}")
    x, y, w, h = values
    return x, y, w, h


def clamp_box(box: tuple[int, int, int, int], width: int, height: int) -> FaceBox:
    """Constrain a detector box to the image bounds.

    A cascade can report a box flush against the edge; clamping keeps the crop
    inside the image instead of producing a padded black border.
    """
    x, y, w, h = box
    x = max(0, min(x, width - 1))
    y = max(0, min(y, height - 1))
    return FaceBox(x=x, y=y, width=max(1, min(w, width - x)), height=max(1, min(h, height - y)))


def import_cv2() -> Any:
    """Import OpenCV, or return None when the `vision` extra is absent.

    Importing lazily keeps this module unit-testable on a host with no OpenCV,
    which is the normal case for a backend-only contributor.
    """
    try:
        import cv2
    except ImportError:
        return None
    return cv2
