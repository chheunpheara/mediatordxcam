"""Image intake validation (§7).

Every upload is re-validated here even though the browser already checked it. The
client check is a courtesy that saves the user a round trip; this one is the
enforcement point, because a `curl` does not care what the React app decided.

The two layers use the *same* error codes, so a message the user saw in the
browser and a rejection here describe the same problem identically.

The size cap is enforced while reading the stream, not after: buffering a 2 GB
body and then measuring it turns a rejected upload into an out-of-memory crash.

Dimensions and format come from parsing the container header, not from decoding
pixels. Decoding untrusted input before deciding whether to accept it is the wrong
order, and a reduced decode is not a safe substitute either: it reports a rounded
size, which is off by one on odd dimensions and would let an image one pixel
under the floor pass it.
"""

from __future__ import annotations

import logging
import struct
from dataclasses import dataclass
from typing import Final

from app.core.errors import USER_MESSAGES, AppError, ErrorCode

logger = logging.getLogger("camdx.uploads")

#: Mirrors the frontend's accept list (§6).
JPEG: Final = "image/jpeg"
PNG: Final = "image/png"
WEBP: Final = "image/webp"
ACCEPTED_MEDIA_TYPES: Final = frozenset({JPEG, PNG, WEBP})

#: Refuse to even look at a header larger than this. A legitimate 10 MB phone
#: photo is tens of kilobytes of header, so this only ever trips on a hostile or
#: malformed file, and it bounds the marker walk below.
MAX_HEADER_BYTES: Final = 64 * 1024

#: Magic bytes for every format worth naming. Only the first three are accepted;
#: the rest exist so the error message can be precise about what arrived.
_SIGNATURES: Final[tuple[tuple[bytes, str], ...]] = (
    (b"\xff\xd8\xff", JPEG),
    (b"\x89PNG\r\n\x1a\n", PNG),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
)

#: WebP is a RIFF container, so the format name sits 8 bytes in rather than at 0.
#: `RIFF` alone is not evidence of anything — WAV and AVI share it.
_RIFF: Final = b"RIFF"
_WEBP_FORM: Final = b"WEBP"

#: WebP payload FourCCs, mapped to how their canvas dimensions are encoded.
_WEBP_CHUNKS: Final = frozenset({b"VP8 ", b"VP8L", b"VP8X"})


@dataclass(frozen=True, slots=True)
class AcceptedImage:
    """A validated upload, ready to hand to a service."""

    data: bytes
    media_type: str
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class ImageHeader:
    """What a container header claims about an image."""

    media_type: str
    width: int
    height: int


def validate_image_upload(
    data: bytes,
    *,
    media_type: str,
    min_width: int,
    min_height: int,
) -> AcceptedImage:
    """Validate uploaded bytes as a JPEG/PNG/WebP of sufficient size and resolution.

    Raises:
        AppError: `UNSUPPORTED_IMAGE_TYPE`, `IMAGE_TOO_LARGE`, `IMAGE_UNREADABLE`
            or `IMAGE_TOO_LOW_RESOLUTION`, each with the user-facing message.
    """
    if media_type not in ACCEPTED_MEDIA_TYPES:
        raise AppError(ErrorCode.UNSUPPORTED_IMAGE_TYPE)

    if not data:
        raise AppError(ErrorCode.IMAGE_UNREADABLE)

    # Distinguish "a real image of a type we do not accept" from "not an image at
    # all", because the user needs a different fix for each: change the format
    # versus try a different file.
    content_type = sniff_media_type(data)
    if content_type is None:
        raise AppError(ErrorCode.IMAGE_UNREADABLE)
    if content_type not in ACCEPTED_MEDIA_TYPES:
        # A GIF or BMP renamed with `Content-Type: image/jpeg` lands here.
        logger.info("upload rejected: unsupported content", extra={"content_type": content_type})
        raise AppError(ErrorCode.UNSUPPORTED_IMAGE_TYPE)

    header = read_image_header(data)
    if header is None:
        raise AppError(ErrorCode.IMAGE_UNREADABLE)

    if header.width < min_width or header.height < min_height:
        # Log the reason, never the bytes, and never pair these with a handle.
        logger.info(
            "upload rejected: resolution",
            extra={"width": header.width, "height": header.height},
        )
        # The message names the actual configured floor rather than repeating a
        # number that could be changed without updating the copy.
        raise AppError(
            ErrorCode.IMAGE_TOO_LOW_RESOLUTION,
            message=USER_MESSAGES[ErrorCode.IMAGE_TOO_LOW_RESOLUTION].format(
                min_width=min_width,
                min_height=min_height,
            ),
        )

    logger.info(
        "upload accepted",
        extra={"width": header.width, "height": header.height, "bytes": len(data)},
    )
    return AcceptedImage(
        data=data,
        media_type=header.media_type,
        width=header.width,
        height=header.height,
    )


def sniff_media_type(data: bytes) -> str | None:
    """Identify an image format from its magic bytes.

    Recognises more formats than are accepted, purely so an unsupported-but-real
    image can be reported as the wrong file type instead of a corrupt one. Returns
    None when the bytes are not any image we can recognise.
    """
    if _is_webp(data):
        return WEBP
    for signature, media_type in _SIGNATURES:
        if data.startswith(signature):
            return media_type
    return None


def read_image_header(data: bytes) -> ImageHeader | None:
    """Identify and measure a supported image from its container header.

    Returns None when the bytes are not a supported image, or when the header is
    truncated or internally inconsistent. Never decodes pixel data.
    """
    if _is_png(data):
        return _read_png_header(data)
    if _is_jpeg(data):
        return _read_jpeg_header(data)
    if _is_webp(data):
        return _read_webp_header(data)
    return None


def _is_jpeg(data: bytes) -> bool:
    """JPEG starts `FFD8FF` then a marker."""
    return len(data) >= 4 and data[:3] == b"\xff\xd8\xff"


def _is_png(data: bytes) -> bool:
    """The eight-byte PNG signature."""
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def _is_webp(data: bytes) -> bool:
    """WebP is `RIFF....WEBP`: the form type is 8 bytes in, past the chunk size."""
    return len(data) >= 12 and data[:4] == _RIFF and data[8:12] == _WEBP_FORM


def _read_png_header(data: bytes) -> ImageHeader | None:
    """Read width and height from the IHDR chunk, which is always first."""
    # signature(8) + length(4) + "IHDR"(4) + width(4) + height(4)
    if len(data) < 24:
        return None
    if data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return _header_or_none(PNG, width, height)


def _read_jpeg_header(data: bytes) -> ImageHeader | None:
    """Walk JPEG markers to the frame header that carries the dimensions.

    Segments before it are skipped by their declared length, so this cannot be
    talked into reading past the end of the buffer.
    """
    offset = 2
    limit = min(len(data), MAX_HEADER_BYTES)
    while offset < limit:
        if data[offset] != 0xFF:
            # Not a marker boundary: the stream is malformed.
            return None
        # Skip any run of fill bytes (0xFF padding) before the marker code.
        while offset < limit and data[offset] == 0xFF:
            offset += 1
        if offset >= limit:
            return None
        marker = data[offset]
        offset += 1

        if marker in _STANDALONE_MARKERS:
            continue
        if offset + 2 > limit:
            return None
        (segment_length,) = struct.unpack(">H", data[offset : offset + 2])
        if segment_length < 2 or offset + segment_length > limit:
            return None

        if marker in _FRAME_MARKERS:
            # SOF payload: precision(1) height(2) width(2) components(1)
            frame = data[offset + 2 : offset + 7]
            if len(frame) < 5:
                return None
            height, width = struct.unpack(">HH", frame[1:5])
            return _header_or_none(JPEG, width, height)

        offset += segment_length
    return None


def _read_webp_header(data: bytes) -> ImageHeader | None:
    """Read the canvas dimensions from the first WebP chunk.

    WebP stores its size differently in each of its three encodings, so the chunk
    FourCC selects the layout. `VP8X` (extended) carries the canvas size that
    covers the whole file; the plain `VP8 ` and `VP8L` bitstreams carry the frame
    size, which is the canvas for a still image.
    """
    if len(data) < 20:
        return None
    chunk = data[12:16]
    if chunk not in _WEBP_CHUNKS:
        # `VP8X` may be preceded by `ICC `/`ALPH`; only the first chunk we can
        # measure is handled, so anything else is treated as unrecognised.
        return None

    if chunk == b"VP8X":
        return _read_vp8x_header(data)
    if chunk == b"VP8L":
        return _read_vp8l_header(data)
    return _read_vp8_header(data)


def _read_vp8x_header(data: bytes) -> ImageHeader | None:
    """Extended format: flags(4) canvas width-1(3) canvas height-1(3), little-endian."""
    if len(data) < 30:
        return None
    width = int.from_bytes(data[24:27], "little") + 1
    height = int.from_bytes(data[27:30], "little") + 1
    return _header_or_none(WEBP, width, height)


def _read_vp8l_header(data: bytes) -> ImageHeader | None:
    """Lossless: a 0x2F signature byte then one 32-bit word packing both dimensions."""
    if len(data) < 25:
        return None
    if data[20] != 0x2F:
        return None
    bits = int.from_bytes(data[21:25], "little")
    width = (bits & 0x3FFF) + 1
    height = ((bits >> 14) & 0x3FFF) + 1
    return _header_or_none(WEBP, width, height)


def _read_vp8_header(data: bytes) -> ImageHeader | None:
    """Lossy: a 3-byte frame tag, the `9D 01 2A` sync code, then 14-bit dimensions."""
    if len(data) < 30:
        return None
    if data[23:26] != b"\x9d\x01\x2a":
        return None
    width = int.from_bytes(data[26:28], "little") & 0x3FFF
    height = int.from_bytes(data[28:30], "little") & 0x3FFF
    return _header_or_none(WEBP, width, height)


#: Markers with no payload; they do not describe a segment length.
_STANDALONE_MARKERS: Final = frozenset({0xD8, 0xD9, 0x01}) | set(range(0xD0, 0xD8))

#: Start-of-frame markers that carry the real dimensions. 0xC4/0xC8/0xCC are
#: Huffman/arithmetic tables, not frames, so they are excluded on purpose.
_FRAME_MARKERS: Final = frozenset(
    {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
)


def _header_or_none(media_type: str, width: int, height: int) -> ImageHeader | None:
    """Reject zero or absurd dimensions, which indicate a broken header."""
    if width <= 0 or height <= 0:
        return None
    if width > 100_000 or height > 100_000:
        return None
    return ImageHeader(media_type=media_type, width=width, height=height)
