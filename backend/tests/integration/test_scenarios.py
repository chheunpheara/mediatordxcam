"""End-to-end scenarios A, D and F (§34).

The flows §34 makes possible, driven through the real HTTP stack with the real
OCR provider: upload a card, let OCR fill the form, then verify. These are the
tests that catch a break *between* phases — a field name the backend and
frontend disagree on, or a requirement gate that disagrees with the OCR result.

Scenario A — ID Card → OCR → API #1 → Success
Scenario D — ID Card → OCR → liveness clip → API #4 → Success
Scenario F — Incorrect identity information → partial/failed

Scenario D's clip arrives exactly as the customer display sends it, a POST to
the broker endpoint, because the recording itself is covered by the broker tests
and the browser tests; what only an end-to-end test catches is the chain after
it — a handle minted by one call being refused by the next.

Scenarios B, C, E, G, H and I have no test in this module; their inputs are
driven, where they are driven at all, by the endpoint tests rather than end to
end.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.deps import artifact_store_provider, document_processor_provider
from app.core.config import Settings
from app.integrations.camdx.mock.ocr import MockOcrProvider
from app.integrations.camdx.mock.verify import FIXTURE_NATIONAL_ID
from app.main import create_app
from app.services.artifacts import TempArtifactStore
from app.services.documents import DocumentProcessor
from app.services.face import FaceService
from app.services.kyc import KycService
from tests.fixtures.detectors import ONE_FACE
from tests.fixtures.images import card_with_face

#: Filling the one field OCR leaves blank. Until this is done the requirement gate
#: refuses the request outright (§11) — that is Scenario A's second test, not this.
_COMPLETED_FORM: dict[str, str] = {"dateOfBirth": "1994-02-11"}

#: The correction that turns a completed form into a passing one. The national ID
#: the mock OCR reads is its own failure marker, so a success requires the user to
#: have noticed and fixed it.
_CORRECTED_ID: dict[str, str] = {"nationalId": "123456789"}

PROCESS = "/api/v1/kyc/id-card/process"
METHODS = "/api/v1/kyc/verification-methods"
VERIFY = "/api/v1/kyc/verify"
LIVENESS = "/api/broker/verify-liveness"

#: What the customer display's MediaRecorder emits, shaped enough for the
#: artefact route to sniff it back as `video/webm`.
_WEBM_CLIP = b"\x1a\x45\xdf\xa3" + b"\x00" * 64

#: §14, verbatim. Spelled out here rather than imported from the app so the
#: scenario asserts the contract the plan states, not what the code happens to
#: export today. If these two ever diverge, this module fails to compile — which
#: is the intended alarm.
IDENTITY_FIELDS = (
    "nationalId",
    "firstNameKhmer",
    "lastNameKhmer",
    "firstNameEnglish",
    "lastNameEnglish",
    "gender",
    "dateOfBirth",
    "issuedDate",
    "expiryDate",
)


@pytest.fixture
async def client(settings: Settings) -> AsyncIterator[AsyncClient]:
    """One app, one artifact store, shared by processing and verification.

    Both halves must see the same store, or the `documentRef` that OCR returns
    could not be resolved by a later verify call.
    """
    store = TempArtifactStore(settings.temp_storage_dir, ttl_seconds=900)
    app = create_app(settings)
    app.dependency_overrides[artifact_store_provider] = lambda: store
    app.dependency_overrides[document_processor_provider] = lambda: DocumentProcessor(
        ocr=MockOcrProvider(),
        face=FaceService(store, ONE_FACE),  # type: ignore[arg-type]
        store=store,
    )
    app.dependency_overrides[KycService.__call__] = lambda: KycService(
        mode=settings.camdx_mode, store=store
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


async def _process(client: AsyncClient) -> dict:
    """Upload a card and return the whole processing result — `documentRef`,
    the OCR fields and everything else the form and the gates read off it."""
    response = await client.post(
        PROCESS,
        files={"document": ("id.jpg", card_with_face(), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _ocr_identity(client: AsyncClient) -> dict[str, str | None]:
    """Process a card and return exactly the nine §14 fields, as the form would."""
    identity = (await _process(client))["ocr"]["fields"]
    return {field: identity.get(field) for field in IDENTITY_FIELDS}


async def _verify(client: AsyncClient, supplied: dict[str, str | None]):
    return await client.post(
        VERIFY,
        json={"method": "verify_user_info", "userInformation": supplied},
    )


# --- Scenario A -------------------------------------------------------------


@pytest.mark.asyncio
async def test_scenario_a_corrected_identity_verifies_as_success(client: AsyncClient) -> None:
    """ID Card → OCR → API #1 → Success.

    Note the correction step: the mock OCR reads the fixture's own national ID,
    which the mock verifier treats as a known-wrong value. A success therefore
    requires the user to have fixed it — which is the realistic path, and the one
    that proves the form really feeds verification (§14).
    """
    supplied = {**(await _ocr_identity(client)), **_COMPLETED_FORM, **_CORRECTED_ID}

    verified = await _verify(client, supplied)

    assert verified.status_code == 200, verified.text
    assert verified.json()["status"] == "success"
    assert verified.json()["identity"]["matchedCount"] == len(IDENTITY_FIELDS)
    assert verified.json()["identity"]["incorrectFields"] == []


@pytest.mark.asyncio
async def test_scenario_a_gate_refuses_until_the_user_completes_the_form(
    client: AsyncClient,
) -> None:
    """The realistic path: OCR leaves a field blank and the user types it (§14).

    Both halves of the loop matter. Refusing an incomplete form is the gate; then
    accepting it once the user fills the gap proves the refusal was about missing
    data rather than about the request being malformed.
    """
    supplied = await _ocr_identity(client)

    refused = await _verify(client, supplied)
    assert refused.status_code == 422
    assert refused.json()["error"]["missing"] == ["userInfo"]

    accepted = await _verify(client, {**supplied, **_COMPLETED_FORM, **_CORRECTED_ID})
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "success"


@pytest.mark.asyncio
async def test_scenario_a_method_is_offered_before_the_user_chooses(
    client: AsyncClient,
) -> None:
    """§19: the method list exists before verification runs, not after it."""
    listed = await client.get(METHODS)

    assert listed.status_code == 200
    runnable = [m["method"] for m in listed.json()["methods"] if m["available"]]
    assert runnable == [
        "verify_user_info",
        "verify_user_info_face",
        "verify_user_info_idcard_face",
        "verify_user_info_idcard_liveness",
    ]


# --- Scenario D -------------------------------------------------------------


@pytest.mark.asyncio
async def test_scenario_d_liveness_turns_api_4_into_a_success(client: AsyncClient) -> None:
    """ID Card → OCR → liveness → API #4 → Success.

    Three handles in one request: the document the OCR call minted, the clip the
    broker call minted, and the identity the form corrected. Before Phase 7 the
    third handle had nowhere to come from and the method card said so; the
    refusal now is a genuinely missing input, never the phase itself.
    """
    card = await _process(client)
    identity = {field: card["ocr"]["fields"].get(field) for field in IDENTITY_FIELDS}

    clip = await client.post(
        LIVENESS,
        files={"liveness_video": ("clip.webm", _WEBM_CLIP, "video/webm")},
    )
    assert clip.status_code == 201, clip.text

    verified = await client.post(
        VERIFY,
        json={
            "method": "verify_user_info_idcard_liveness",
            "userInformation": {**identity, **_COMPLETED_FORM, **_CORRECTED_ID},
            "idCardRef": card["documentRef"],
            "livenessRef": clip.json()["livenessRef"],
        },
    )

    assert verified.status_code == 200, verified.text
    body = verified.json()
    assert body["status"] == "success"
    assert body["identity"]["incorrectFields"] == []
    assert body["idCard"] == {"required": True, "verified": True}
    assert body["liveness"] == {"required": True, "verified": True}


# --- Scenario F -------------------------------------------------------------


@pytest.mark.asyncio
async def test_scenario_f_wrong_information_is_a_negative_result_not_an_error(
    client: AsyncClient,
) -> None:
    """Incorrect identity information → failed.

    The distinction that matters: submitting an identity CamDX rejects is a
    *successful API call with a negative answer*. A 4xx would tell the user their
    request was malformed when in fact the check was performed and the answer was
    no. The form is already known to be well-formed — the gate passed.
    """
    supplied = {**(await _ocr_identity(client)), **_COMPLETED_FORM}

    verified = await _verify(client, supplied)

    assert verified.status_code == 200, verified.text
    assert verified.json()["status"] == "failed"


@pytest.mark.asyncio
async def test_scenario_f_names_every_field_it_rejected(client: AsyncClient) -> None:
    """A failure that names no fields leaves the user nothing to correct.

    Also the honest scope note: the mock judges identity as a whole from the
    national ID, so it can express "all of this is wrong" but not "one field of
    nine is wrong". This test pins the whole-identity case, which is what the mock
    can actually express, rather than asserting a per-field rule it cannot.
    """
    supplied = {**(await _ocr_identity(client)), **_COMPLETED_FORM}

    identity = (await _verify(client, supplied)).json()["identity"]

    assert identity["incorrectFields"] == list(IDENTITY_FIELDS)
    assert all(field["status"] == "mismatch" for field in identity["fields"])
    assert identity["matchedCount"] == 0


@pytest.mark.asyncio
async def test_scenario_f_is_reachable_without_any_magic_input(client: AsyncClient) -> None:
    """No secret code switches the mock into failing (§16, §21).

    The failure arrives from the ordinary OCR fixture, so a reviewer can reproduce
    it by uploading a sample card — no test-only header or magic string.
    """
    supplied = {**(await _ocr_identity(client)), **_COMPLETED_FORM}

    assert supplied["nationalId"] == FIXTURE_NATIONAL_ID
    assert (await _verify(client, supplied)).json()["status"] == "failed"
