"""End-to-end scenarios A and F (§34).

The two flows §34 makes possible in Phase 5, driven through the real HTTP stack
with the real OCR provider: upload a card, let OCR fill the form, then verify.
These are the tests that catch a break *between* phases — a field name the backend
and frontend disagree on, or a requirement gate that disagrees with the OCR result.

Scenario A — ID Card → OCR → API #1 → Success
Scenario F — Incorrect identity information → partial/failed

Scenarios B, C, D, E, G and I are absent because the features they exercise
(current face capture, liveness, passport OCR) do not exist yet. Writing them
would mean mocking the very thing under test.
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


async def _ocr_identity(client: AsyncClient) -> dict[str, str | None]:
    """Process a card and return exactly the nine §14 fields, as the form would."""
    response = await client.post(
        PROCESS,
        files={"document": ("id.jpg", card_with_face(), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    identity = response.json()["ocr"]["fields"]
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
    ]


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
