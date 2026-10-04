"""The ID-card processing endpoint as the browser sees it (§7, §14).

HTTP-level tests rather than service tests, because what breaks at this boundary
is transport: multipart parsing, the size cap, status codes, cache headers, and
the field names the frontend reads.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.deps import artifact_store_provider, document_processor_provider
from app.core.config import Settings
from app.domain.enums import FaceExtractionStatus, FaceSource
from app.integrations.camdx.mock.ocr import MockOcrProvider
from app.main import create_app
from app.services.artifacts import TempArtifactStore
from app.services.documents import DocumentProcessor
from app.services.face import FaceService
from tests.fixtures.detectors import NO_FACE, ONE_FACE
from tests.fixtures.images import encode_jpeg, encode_png, encode_webp, textured_card

ENDPOINT = "/api/v1/kyc/id-card/process"


@pytest.fixture
def make_app(settings: Settings):
    """An app whose OCR and detector are both fixtures."""

    def build(detector: object = ONE_FACE, *, unreadable: bool = False):
        store = TempArtifactStore(settings.temp_storage_dir, ttl_seconds=900)
        app = create_app(settings)
        app.dependency_overrides[artifact_store_provider] = lambda: store
        app.dependency_overrides[document_processor_provider] = lambda: DocumentProcessor(
            ocr=MockOcrProvider(unreadable=unreadable),
            face=FaceService(store, detector),  # type: ignore[arg-type]
            store=store,
        )
        return app, store

    return build


@pytest.fixture
async def send(make_app):
    """Post bytes to the endpoint, returning `(response, store)`."""

    async def post(
        blob: bytes,
        *,
        filename: str = "id.jpg",
        content_type: str = "image/jpeg",
        detector: object = ONE_FACE,
        unreadable: bool = False,
    ):
        app, store = make_app(detector, unreadable=unreadable)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            response = await http.post(
                ENDPOINT,
                files={"document": (filename, blob, content_type)},
            )
        return response, store

    return post


@pytest.fixture
async def get(make_app):
    """Issue a bare GET, for the artefact-handle tests."""

    async def request(path: str):
        app, store = make_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            return await http.get(path), store

    return request


def card() -> bytes:
    return encode_jpeg(textured_card())


async def test_a_valid_card_is_accepted(send) -> None:
    response, _ = await send(card())

    assert response.status_code == 200, response.text


async def test_the_response_carries_the_contract_the_frontend_reads(send) -> None:
    """Every key here is one the workspace client is written against."""
    response, _ = await send(card())

    body = response.json()
    assert set(body) >= {"processingId", "status", "ocr", "face", "documentRef"}
    assert set(body["ocr"]) >= {"status", "documentType", "fields", "missingFields"}
    assert set(body["face"]) >= {"status", "source", "detectedCount", "faceRef"}


async def test_the_identity_fields_are_exactly_the_nine_of_section_14(send) -> None:
    """§14 lists nine fields, so the form's rows are pinned to exactly those.

    Asserted by equality rather than containment: §14 is a closed list, and an
    eleventh field would put a row on the form that the plan never asked for,
    while a rename would silently stop populating an input the user must correct.
    """
    response, _ = await send(card())

    assert set(response.json()["ocr"]["fields"]) == {
        "nationalId",
        "firstNameKhmer",
        "lastNameKhmer",
        "firstNameEnglish",
        "lastNameEnglish",
        "dateOfBirth",
        "gender",
        "issuedDate",
        "expiryDate",
    }


async def test_the_english_name_is_not_a_copy_of_the_khmer_name(send) -> None:
    """§14 gives Khmer and English names separate rows.

    A Khmer card prints both scripts, and they transliterate differently. Copying
    one into the other would hand the user two fields that always agree, so a
    transcription error in either would be invisible.
    """
    response, _ = await send(card())

    fields = response.json()["ocr"]["fields"]
    assert fields["firstNameKhmer"] != fields["firstNameEnglish"]
    assert fields["lastNameKhmer"] != fields["lastNameEnglish"]


async def test_the_face_is_never_presented_as_verified(send) -> None:
    """§13: a local detection has no verification field.

    If `verified` or a match score appeared here, the UI could tell a user their
    face was confirmed against a government record when nothing was compared.
    """
    response, _ = await send(card())

    face = response.json()["face"]
    assert "verified" not in face
    assert "matchScore" not in face
    assert face["source"] == FaceSource.LOCAL_DETECTION.value


async def test_identity_fields_survive_a_missing_face(send) -> None:
    """The two reads are independent, so a failed portrait is not a failed request."""
    response, _ = await send(card(), detector=NO_FACE)

    body = response.json()
    assert body["face"]["status"] == FaceExtractionStatus.NOT_DETECTED.value
    assert body["face"]["faceRef"] is None
    assert body["ocr"]["fields"]["nationalId"] == "000000000000"


async def test_the_face_is_addressed_by_an_opaque_handle(send) -> None:
    response, store = await send(card())

    handle = response.json()["face"]["faceRef"]
    assert handle.startswith("art_")
    # Retrievable server-side, and never carrying a path.
    assert store.read(handle)
    assert response.json()["documentRef"].startswith("art_")


async def test_the_extracted_face_can_be_fetched_by_its_handle(send, get) -> None:
    """The whole point of the handle: the browser can render the crop."""
    response, _ = await send(card())
    handle = response.json()["face"]["faceRef"]

    fetched, _ = await get(f"/api/v1/kyc/artifacts/{handle}")

    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "image/jpeg"
    assert fetched.content.startswith(b"\xff\xd8\xff")


async def test_the_original_card_can_be_fetched_by_its_handle(send, get) -> None:
    """§14 shows the card beside the extracted data, so it must be retrievable."""
    response, _ = await send(card())

    fetched, _ = await get(f"/api/v1/kyc/artifacts/{response.json()['documentRef']}")

    assert fetched.status_code == 200
    assert fetched.content.startswith(b"\xff\xd8\xff")


@pytest.mark.parametrize(
    ("encode", "filename", "content_type", "signature"),
    [
        pytest.param(encode_jpeg, "id.jpg", "image/jpeg", b"\xff\xd8\xff", id="jpeg"),
        pytest.param(encode_png, "id.png", "image/png", b"\x89PNG", id="png"),
        pytest.param(encode_webp, "id.webp", "image/webp", b"RIFF", id="webp"),
    ],
)
async def test_every_accepted_format_round_trips_through_its_handle(
    send, get, encode, filename: str, content_type: str, signature: bytes
) -> None:
    """A stored artefact must be served back under the type it was stored as.

    Regression guard: the endpoint keeps its own allow-list of servable types, so
    accepting a new upload format without adding it here turns every retrieval of
    that format into a 404 — the upload succeeds and the image silently never
    appears.
    """
    response, _ = await send(encode(textured_card()), filename=filename, content_type=content_type)
    assert response.status_code == 200

    fetched, _ = await get(f"/api/v1/kyc/artifacts/{response.json()['documentRef']}")

    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == content_type
    assert fetched.content.startswith(signature)


async def test_artefact_responses_are_private_and_uncached(make_app, send) -> None:
    response, _ = await send(card())
    handle = response.json()["face"]["faceRef"]
    app, _ = make_app()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        fetched = await http.get(f"/api/v1/kyc/artifacts/{handle}")

    assert "no-store" in fetched.headers.get("cache-control", "")
    assert "private" in fetched.headers.get("cache-control", "")


async def test_a_missing_field_is_reported_so_the_ui_can_ask(send) -> None:
    """§16: the user is prompted for what OCR could not read."""
    response, _ = await send(card())

    body = response.json()
    assert body["ocr"]["missingFields"] == ["dateOfBirth"]
    assert body["status"] == "partial"


@pytest.mark.parametrize(
    ("content_type", "filename"),
    [("application/pdf", "doc.pdf"), ("image/gif", "card.gif")],
)
async def test_a_wrong_file_type_is_refused(send, content_type: str, filename: str) -> None:
    response, _ = await send(b"%PDF-1.7 pretend", filename=filename, content_type=content_type)

    assert response.status_code in (400, 415)
    assert response.json()["error"]["code"] == "UNSUPPORTED_IMAGE_TYPE"


async def test_a_png_declared_as_jpeg_is_accepted_as_the_png_it_is(send) -> None:
    """Renaming is harmless: the response reports the real type, not the claim."""
    response, _ = await send(encode_png(textured_card()), content_type="image/jpeg")

    assert response.status_code == 200
    assert response.json()["ocr"]["documentType"] == "khmer_id_card"


async def test_an_unreadable_image_is_refused(send) -> None:
    response, _ = await send(b"not an image at all")

    assert response.status_code in (400, 422)
    assert response.json()["error"]["code"] == "IMAGE_UNREADABLE"


async def test_an_undersized_card_is_refused(send) -> None:
    """The server enforces the floor the browser checked, so a curl cannot skip it."""
    from tests.fixtures.images import blank_card

    response, _ = await send(encode_jpeg(blank_card(width=320, height=240)))

    assert response.status_code in (400, 422)
    assert response.json()["error"]["code"] == "IMAGE_TOO_LOW_RESOLUTION"


async def test_an_oversized_upload_is_refused(send, settings: Settings) -> None:
    """The cap is enforced while streaming, so a huge body is never buffered."""
    oversized = b"\xff\xd8\xff" + b"\x00" * (settings.max_upload_bytes + 1)

    response, _ = await send(oversized)

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "IMAGE_TOO_LARGE"


async def test_an_unreadable_card_reports_a_business_error(send) -> None:
    response, _ = await send(card(), unreadable=True)

    assert response.status_code in (400, 422)
    assert response.json()["error"]["code"] == "OCR_UNREADABLE"


async def test_a_rejected_upload_leaves_nothing_on_disk(send) -> None:
    """Every failure would otherwise keep a document for the full TTL."""
    _, store = await send(card(), unreadable=True)

    assert list(store.root.iterdir()) == []


async def test_error_bodies_carry_a_user_facing_message(send) -> None:
    """The frontend renders `message` directly; a missing one leaks raw text."""
    response, _ = await send(b"not an image at all")

    assert response.json()["error"]["message"]


async def test_the_processing_response_is_not_cacheable(send) -> None:
    response, _ = await send(card())

    assert "no-store" in response.headers.get("cache-control", "")


@pytest.mark.parametrize(
    "attempt",
    ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "art_short", "art_" + "z" * 32, ".."],
)
async def test_a_handle_cannot_reach_an_arbitrary_path(get, attempt: str) -> None:
    """Traversal is unrepresentable rather than filtered; every shape is just 404."""
    response, _ = await get(f"/api/v1/kyc/artifacts/{attempt}")

    assert response.status_code == 404


async def test_an_unknown_handle_is_not_found(send, get) -> None:
    from app.core.ids import new_artifact_handle

    response, _ = await get(f"/api/v1/kyc/artifacts/{new_artifact_handle()}")

    assert response.status_code == 404
