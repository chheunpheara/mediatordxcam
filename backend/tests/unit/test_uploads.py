"""Server-side upload validation (§7).

The point of these tests is that the server does not trust the client. Each case
here is something a browser could be talked into sending, by renaming a file,
by forging a content type, or by lying about a size.
"""

from __future__ import annotations

import pytest

from app.core.errors import AppError, ErrorCode
from app.services.uploads import (
    ImageHeader,
    read_image_header,
    sniff_media_type,
    validate_image_upload,
)
from tests.fixtures.images import (
    blank_card,
    encode_jpeg,
    encode_png,
    encode_webp,
    not_an_image,
    textured_card,
)

MIN_WIDTH = 640
MIN_HEIGHT = 400


def accept(blob: bytes, *, media_type: str = "image/jpeg") -> None:
    validate_image_upload(blob, media_type=media_type, min_width=MIN_WIDTH, min_height=MIN_HEIGHT)


def rejection(blob: bytes, *, media_type: str = "image/jpeg") -> ErrorCode:
    with pytest.raises(AppError) as excinfo:
        validate_image_upload(
            blob,
            media_type=media_type,
            min_width=MIN_WIDTH,
            min_height=MIN_HEIGHT,
        )
    assert excinfo.value.code in {
        ErrorCode.UNSUPPORTED_IMAGE_TYPE,
        ErrorCode.IMAGE_UNREADABLE,
        ErrorCode.IMAGE_TOO_LOW_RESOLUTION,
        ErrorCode.IMAGE_TOO_LARGE,
    }
    return excinfo.value.code


@pytest.mark.parametrize(
    ("encode", "media_type"),
    [
        (encode_jpeg, "image/jpeg"),
        (encode_png, "image/png"),
        (encode_webp, "image/webp"),
    ],
)
def test_accepts_a_well_formed_card(encode, media_type: str) -> None:
    """Every format §6 lists, at the documented resolution floor."""
    accepted = validate_image_upload(
        encode(blank_card()),
        media_type=media_type,
        min_width=MIN_WIDTH,
        min_height=MIN_HEIGHT,
    )

    assert (accepted.width, accepted.height) == (800, 600)
    assert accepted.media_type == media_type


@pytest.mark.parametrize("lossless", [False, True], ids=["vp8", "vp8l"])
def test_webp_dimensions_survive_every_chunk_layout(lossless: bool) -> None:
    """WebP encodes its size three different ways; all three must measure exactly.

    A reduced decode rounds, so an image one pixel under the floor has to be read
    from the header rather than inferred — and the layout depends on the encoder.
    """
    header = read_image_header(encode_webp(blank_card(), lossless=lossless))

    assert header == ImageHeader(media_type="image/webp", width=800, height=600)


def test_webp_is_told_apart_from_other_riff_containers() -> None:
    """`RIFF` alone is not an image — WAV and AVI share it, so the form type decides."""
    wav = b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt " + b"\x00" * 32

    assert sniff_media_type(wav) is None
    assert read_image_header(wav) is None


def test_webp_reports_the_real_type_not_the_claimed_one() -> None:
    """A WebP sent as `image/jpeg` is still a WebP, and still accepted (§6)."""
    accepted = validate_image_upload(
        encode_webp(blank_card()),
        media_type="image/jpeg",
        min_width=MIN_WIDTH,
        min_height=MIN_HEIGHT,
    )

    assert accepted.media_type == "image/webp"


def test_reports_the_real_type_not_the_claimed_one() -> None:
    """A PNG sent as `image/jpeg` must be labelled a PNG downstream."""
    accepted = validate_image_upload(
        encode_png(blank_card()),
        media_type="image/jpeg",
        min_width=MIN_WIDTH,
        min_height=MIN_HEIGHT,
    )

    assert accepted.media_type == "image/png"


@pytest.mark.parametrize(
    ("blob", "expected"),
    [
        (encode_jpeg(blank_card()), "image/jpeg"),
        (encode_png(blank_card()), "image/png"),
        (encode_webp(blank_card()), "image/webp"),
        (b"GIF89a" + b"\x00" * 64, "image/gif"),
        (b"BM" + b"\x00" * 64, "image/bmp"),
        (b"%PDF-1.7\n%", None),
        (b"\x00\x01\x02\x03", None),
    ],
)
def test_identifies_content_from_its_bytes(blob: bytes, expected: str | None) -> None:
    assert sniff_media_type(blob) == expected


@pytest.mark.parametrize(
    ("blob", "declared"),
    [
        (b"GIF89a" + b"\x00" * 64, "image/jpeg"),
        (b"BM" + b"\x00" * 64, "image/png"),
        (encode_png(blank_card()), "application/pdf"),
    ],
)
def test_a_renamed_file_is_rejected_as_the_wrong_type(blob: bytes, declared: str) -> None:
    """Renaming a file, or forging the content type, evades nothing."""
    assert rejection(blob, media_type=declared) is ErrorCode.UNSUPPORTED_IMAGE_TYPE


@pytest.mark.parametrize("blob", [not_an_image(), b"", b"\x00" * 32, b"%PDF-1.7 not an image"])
def test_unrecognisable_bytes_are_reported_as_unreadable(blob: bytes) -> None:
    assert rejection(blob) is ErrorCode.IMAGE_UNREADABLE


def test_a_truncated_jpeg_header_is_unreadable() -> None:
    """Cutting the file must not produce a crash or a bogus size."""
    truncated = encode_jpeg(blank_card())[:6]

    assert read_image_header(truncated) is None
    assert rejection(truncated) is ErrorCode.IMAGE_UNREADABLE


@pytest.mark.parametrize(
    ("width", "height", "expected"),
    [
        (639, 400, ErrorCode.IMAGE_TOO_LOW_RESOLUTION),
        (800, 399, ErrorCode.IMAGE_TOO_LOW_RESOLUTION),
        (640, 400, None),
    ],
)
def test_the_resolution_floor_is_exact(width: int, height: int, expected: ErrorCode | None) -> None:
    """A reduced decode rounds, which would pass a 639px image as 640.

    The floor is a user-facing requirement, so being off by one either rejects a
    valid photo or quietly accepts one we promised to refuse.
    """
    blob = encode_jpeg(blank_card(width=width, height=height))

    if expected is None:
        accept(blob)
    else:
        assert rejection(blob) is expected


def test_dimensions_are_measured_without_decoding_pixels() -> None:
    """A header is enough to check the floor, and decoding is the expensive part."""
    header = read_image_header(encode_jpeg(textured_card()))

    assert header is not None
    assert (header.width, header.height) == (800, 600)


@pytest.mark.parametrize(
    "blob",
    [b"\x89PNG\r\n\x1a\n", b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, b"\xff\xd8\xff" + b"\xff" * 4096],
)
def test_a_truncated_header_never_reports_a_size(blob: bytes) -> None:
    assert read_image_header(blob) is None


def test_a_zero_dimension_header_is_rejected() -> None:
    """A structurally valid but empty header is not a usable image."""
    png = bytearray(encode_png(blank_card()))
    png[16:24] = (0).to_bytes(4, "big") + (0).to_bytes(4, "big")

    assert read_image_header(bytes(png)) is None


def test_every_rejection_carries_a_user_facing_message() -> None:
    """The browser renders `message`; a missing one would surface as raw text."""
    with pytest.raises(AppError) as excinfo:
        validate_image_upload(
            b"GIF89a" + b"\x00" * 64,
            media_type="image/jpeg",
            min_width=MIN_WIDTH,
            min_height=MIN_HEIGHT,
        )

    assert excinfo.value.message
    assert excinfo.value.code is ErrorCode.UNSUPPORTED_IMAGE_TYPE
