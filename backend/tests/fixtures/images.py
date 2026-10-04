"""Synthetic image fixtures (§29).

No real ID card, face or passport image is committed, and none is needed: OpenCV
can draw a card-shaped image, and the *face rules* are tested through a scripted
detector (`tests/fixtures/detectors.py`) rather than by trying to fool a cascade
trained on photographs.

Generated at test time so the repository cannot accumulate biometric-looking
binaries, and so a fixture can be retuned without a binary diff.
"""

from __future__ import annotations

import numpy as np

#: Above the 640x400 floor, so upload validation accepts these.
WIDTH = 800
HEIGHT = 600


def blank_card(width: int = WIDTH, height: int = HEIGHT) -> np.ndarray:
    """A flat, light card-shaped background. Contains no face."""
    return np.full((height, width, 3), 235, dtype=np.uint8)


def encode_jpeg(image: np.ndarray, quality: int = 90) -> bytes:
    """Encode a BGR array as JPEG bytes."""
    import cv2

    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok, "failed to encode fixture"
    return buffer.tobytes()


def encode_png(image: np.ndarray) -> bytes:
    """Encode a BGR array as PNG bytes."""
    import cv2

    ok, buffer = cv2.imencode(".png", image)
    assert ok, "failed to encode fixture"
    return buffer.tobytes()


def encode_webp(image: np.ndarray, *, lossless: bool = False) -> bytes:
    """Encode a BGR array as WebP bytes (§6).

    `lossless` selects the `VP8L` chunk layout instead of the default lossy `VP8 `,
    so the header parser can be exercised against both encodings.
    """
    import cv2

    params = [16, 1] if lossless else [int(cv2.IMWRITE_WEBP_QUALITY), 80]
    ok, buffer = cv2.imencode(".webp", image, params)
    assert ok, "failed to encode fixture"
    return buffer.tobytes()


def card_without_face() -> bytes:
    """A card-shaped image with no face."""
    return encode_jpeg(blank_card())


def textured_region_card() -> bytes:
    """A card whose whole surface has detail, so a crop has real quality.

    Flat colour is not enough: the quality check measures sharpness, so an
    entirely flat fixture is correctly rejected as low quality. Tests that need a
    usable crop need texture.
    """
    rng = np.random.default_rng(11)
    image = blank_card().astype(np.float32)
    image += rng.normal(0, 18, image.shape).astype(np.float32)
    return encode_jpeg(np.clip(image, 0, 255).astype(np.uint8))


def textured_card(width: int = WIDTH, height: int = HEIGHT) -> np.ndarray:
    """A card with a drawn, textured face — a plausible cascade input.

    Used by the one integration test that runs the real Haar detector. It asserts
    only that the wiring runs and returns a valid outcome, never that a specific
    number of faces is found: that number depends on the cascade shipped by the
    installed OpenCV, which is not a property of this application.
    """
    rng = np.random.default_rng(7)
    image = np.full((height, width), 225, dtype=np.uint8)
    cx, cy = width // 2, int(height * 0.48)

    import cv2

    cv2.ellipse(image, (cx, cy), (135, 175), 0, 0, 360, 190, -1)
    cv2.rectangle(image, (cx - 90, cy + 150), (cx + 90, height), (120, 120, 120), -1)

    grey = image.astype(np.float32)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    head = ((xx - cx) / 135.0) ** 2 + ((yy - cy) / 175.0) ** 2 <= 1
    grey[head] += (1 - (yy[head] - cy) / 175.0) * 18 - 18
    image = np.clip(grey, 0, 255).astype(np.uint8)

    for sign in (-1, 1):
        cv2.ellipse(image, (cx + sign * 48, cy - 18), (30, 15), 0, 0, 360, 55, -1)
        cv2.circle(image, (cx + sign * 48, cy - 18), 10, 35, -1)
        cv2.ellipse(image, (cx + sign * 48, cy - 48), (36, 8), 0, 180, 360, 65, -1)
    cv2.ellipse(image, (cx, cy + 42), (16, 38), 0, 0, 360, 205, -1)
    for sign in (-1, 1):
        cv2.ellipse(image, (cx + sign * 15, cy + 72), (10, 6), 0, 0, 360, 70, -1)
    cv2.ellipse(image, (cx, cy + 105), (46, 14), 0, 0, 360, 100, -1)
    cv2.ellipse(image, (cx, cy - 88), (140, 110), 180, 360, 60, 50, -1)

    noisy = image.astype(np.float32) + rng.normal(0, 7, image.shape).astype(np.float32)
    single = np.clip(noisy, 0, 255).astype(np.uint8)
    return np.dstack([single, single, single])


def card_with_face() -> bytes:
    """A card with one drawn, textured face."""
    return encode_jpeg(textured_card())


def too_small_image() -> bytes:
    """Below the 640x400 floor, so upload validation rejects it."""
    return encode_jpeg(blank_card(width=320, height=240))


def not_an_image() -> bytes:
    """Bytes that are not a decodable image, despite the name."""
    return b"this is definitely not a JPEG"
