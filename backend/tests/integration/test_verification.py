"""The verification APIs as the browser sees them (§19).

HTTP-level tests, because what matters here is the contract the frontend reads:
six methods with their requirements, a requirement gate that refuses an incomplete
request before any upstream call, and a normalized result that never leaks an
upstream shape or a score (§23, §24).
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.deps import artifact_store_provider
from app.core.config import Settings
from app.core.errors import AppError, ErrorCode
from app.main import create_app
from app.services.artifacts import TempArtifactStore
from app.services.kyc import KycService

METHODS = "/api/v1/kyc/verification-methods"
VERIFY = "/api/v1/kyc/verify"

#: All nine §14 fields filled, so a request clears the `userInfo` requirement.
FULL_IDENTITY = {
    "nationalId": "123456789",
    "firstNameKhmer": "សុខា",
    "lastNameKhmer": "ចម",
    "firstNameEnglish": "Sokha",
    "lastNameEnglish": "Cham",
    "gender": "F",
    "dateOfBirth": "1994-02-11",
    "issuedDate": "2021-04-12",
    "expiryDate": "2029-04-12",
}


@pytest.fixture
def store(settings: Settings) -> TempArtifactStore:
    return TempArtifactStore(settings.temp_storage_dir, ttl_seconds=900)


@pytest.fixture
def client(settings: Settings, store: TempArtifactStore):
    app = create_app(settings)
    app.dependency_overrides[artifact_store_provider] = lambda: store
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def document_ref(store: TempArtifactStore) -> str:
    return store.put(b"\xff\xd8\xffcard", media_type="image/jpeg").handle


@pytest.fixture
def face_ref(store: TempArtifactStore) -> str:
    return store.put(b"\xff\xd8\xffselfie", media_type="image/jpeg").handle


class TestVerificationMethods:
    async def test_lists_all_six_official_apis(self, client) -> None:
        """§9/§19: the six official methods are displayed, all of them."""
        response = await client.get(METHODS)

        assert response.status_code == 200
        assert len(response.json()["methods"]) == 6

    async def test_names_each_api_verbatim(self, client) -> None:
        """§3: official names are rendered verbatim, never renamed."""
        response = await client.get(METHODS)

        names = [m["officialName"] for m in response.json()["methods"]]
        assert names == [
            "Verify User Info",
            "Verify User Info + User Face",
            "Verify User Info + ID Card + User Face",
            "Verify User Info + ID Card Image + Liveness",
            "Khmer ID Card OCR",
            "Passport OCR",
        ]

    async def test_each_method_carries_a_user_friendly_label(self, client) -> None:
        """§10: user-friendly labels, not raw enum values."""
        response = await client.get(METHODS)

        labels = [m["label"] for m in response.json()["methods"]]
        assert "Identity Information" in labels
        assert not any(label.startswith("verify_") for label in labels)

    async def test_requirements_are_sent_as_flags_not_prose(self, client) -> None:
        """§11: the UI builds its inputs from configuration, not from parsing text."""
        response = await client.get(METHODS)

        by_method = {m["method"]: m for m in response.json()["methods"]}
        assert by_method["verify_user_info"]["requiresUserInfo"] is True
        assert by_method["verify_user_info"]["requiresCurrentFace"] is False
        assert by_method["verify_user_info_face"]["requiresCurrentFace"] is True
        assert by_method["verify_user_info_idcard_face"]["requiresIdCard"] is True
        assert by_method["verify_user_info_idcard_liveness"]["requiresLiveness"] is True
        assert by_method["verify_user_info"]["requiresLiveness"] is False

    async def test_api_1_is_offered_and_the_rest_explain_themselves(self, client) -> None:
        """Methods that cannot run stay listed and say why.

        §9 requires all six on screen; §10 needs each to be actionable or to
        explain itself. Hiding the pending ones would satisfy neither — and now
        that Phase 7 supplies liveness, API 4 has crossed over to the runnable
        side, which this asserts as deliberately as it once asserted the reverse.
        """
        response = await client.get(METHODS)

        by_method = {m["method"]: m for m in response.json()["methods"]}
        assert by_method["verify_user_info"]["available"] is True
        assert by_method["verify_user_info"]["unavailableReason"] is None

        for now_available in (
            "verify_user_info_face",
            "verify_user_info_idcard_face",
            "verify_user_info_idcard_liveness",
        ):
            assert by_method[now_available]["available"] is True
            assert by_method[now_available]["unavailableReason"] is None

        for pending in ("khmer_id_card_ocr", "passport_ocr"):
            assert by_method[pending]["available"] is False
            assert by_method[pending]["unavailableReason"]

    async def test_ocr_methods_are_flagged_as_not_verifications(self, client) -> None:
        """API 5/6 read documents; `verify` does not run them."""
        response = await client.get(METHODS)

        ocr = [m for m in response.json()["methods"] if m["isOcr"]]
        assert {m["method"] for m in ocr} == {"khmer_id_card_ocr", "passport_ocr"}


class TestVerify:
    async def test_api_1_verifies_a_complete_identity(self, client) -> None:
        response = await client.post(
            VERIFY,
            json={"method": "verify_user_info", "userInformation": FULL_IDENTITY},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "success"
        assert body["method"] == "verify_user_info"
        assert body["identity"]["incorrectFields"] == []
        assert body["identity"]["matchedCount"] == 9

    async def test_an_incomplete_identity_is_refused_before_any_upstream_call(
        self, client, document_ref: str
    ) -> None:
        """§11: the backend validates independently of the UI.

        The form is deliberately left incomplete even though an ID card is
        available, so a frontend that skipped validation could not produce this
        request.
        """
        response = await client.post(
            VERIFY,
            json={
                "method": "verify_user_info",
                "userInformation": {**FULL_IDENTITY, "dateOfBirth": ""},
                "idCardRef": document_ref,
            },
        )

        assert response.status_code == 422
        error = response.json()["error"]
        assert error["code"] == ErrorCode.REQUIREMENTS_NOT_MET.value
        assert error["missing"] == ["userInfo"]

    async def test_the_missing_flags_name_the_specific_input(
        self, client, document_ref: str
    ) -> None:
        """§11: the UI points at the right input instead of printing prose."""
        response = await client.post(
            VERIFY,
            json={
                "method": "verify_user_info_idcard_face",
                "userInformation": FULL_IDENTITY,
                "idCardRef": document_ref,
                "currentFaceRef": None,
            },
        )

        assert response.status_code == 422
        assert response.json()["error"]["missing"] == ["currentFace"]

    async def test_api_4_never_runs_without_liveness(self, client, document_ref: str) -> None:
        """`:1355`: API 4 cannot execute without the required liveness state."""
        response = await client.post(
            VERIFY,
            json={
                "method": "verify_user_info_idcard_liveness",
                "userInformation": FULL_IDENTITY,
                "idCardRef": document_ref,
            },
        )

        assert response.status_code == 422
        assert response.json()["error"]["missing"] == ["liveness"]

    async def test_an_ocr_method_cannot_be_used_to_verify(self, client, document_ref: str) -> None:
        """§19: `verify` takes a verification method, not a document read."""
        response = await client.post(
            VERIFY,
            json={"method": "khmer_id_card_ocr", "idCardRef": document_ref},
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == ErrorCode.INVALID_REQUEST.value

    async def test_an_unknown_method_is_rejected(self, client) -> None:
        response = await client.post(VERIFY, json={"method": "verify_by_vibes"})

        assert response.status_code == 400
        assert response.json()["error"]["code"] == ErrorCode.INVALID_REQUEST.value

    async def test_an_unknown_reference_is_not_treated_as_no_input(self, client) -> None:
        """A typo'd handle is a bad request, not a silent "nothing supplied".

        §19 notes backend validation; passing a nonexistent handle through to the
        adapter would read as an absent card and produce a wrong verification.
        """
        response = await client.post(
            VERIFY,
            json={
                "method": "verify_user_info_face",
                "userInformation": FULL_IDENTITY,
                "currentFaceRef": "art_nope",
            },
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == ErrorCode.ARTIFACT_NOT_FOUND.value

    async def test_a_mismatched_identity_is_reported_as_failed(self, client) -> None:
        """The mock's own marker value fails, so the failure path is reachable."""
        response = await client.post(
            VERIFY,
            json={
                "method": "verify_user_info",
                "userInformation": {**FULL_IDENTITY, "nationalId": "000000000000"},
            },
        )

        body = response.json()
        assert body["status"] == "failed"
        assert "nationalId" in body["identity"]["incorrectFields"]

    async def test_sections_a_method_never_used_are_marked_not_required(self, client) -> None:
        """§25: API 1 must not render a face or ID Card section.

        Asserted through `required`, because a section reported as `verified:
        false` for a method that never compared a face is indistinguishable from a
        failed face check.
        """
        response = await client.post(
            VERIFY,
            json={"method": "verify_user_info", "userInformation": FULL_IDENTITY},
        )

        body = response.json()
        assert body["face"] == {"required": False, "verified": None}
        assert body["idCard"] == {"required": False, "verified": None}
        assert body["liveness"] == {"required": False, "verified": None}

    async def test_no_score_or_upstream_detail_is_exposed(self, client) -> None:
        """§24: never show internal score fields or the API response."""
        response = await client.post(
            VERIFY,
            json={"method": "verify_user_info", "userInformation": FULL_IDENTITY},
        )

        body = response.text.lower()
        for leak in ("score", "confidence", "endpoint", "http", "raw", "payload"):
            assert leak not in body, f"verify response leaked {leak!r}"

    async def test_the_result_is_normalized_not_the_providers_shape(self, client) -> None:
        """§23: the frontend must not depend on CamDX's response structure."""
        response = await client.post(
            VERIFY,
            json={"method": "verify_user_info", "userInformation": FULL_IDENTITY},
        )

        body = response.json()
        assert set(body) == {"status", "method", "identity", "face", "idCard", "liveness"}
        assert set(body["identity"]) == {"fields", "matchedCount", "incorrectFields"}

    async def test_an_unexpected_field_is_refused(self, client) -> None:
        """§30: a typo'd `idCardRef` must not read as "no card supplied"."""
        response = await client.post(
            VERIFY,
            json={
                "method": "verify_user_info_idcard_face",
                "userInformation": FULL_IDENTITY,
                "idcardRef": "art_typo",
                "currentFaceRef": "art_face",
            },
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == ErrorCode.INVALID_REQUEST.value


class TestServiceBehaviour:
    async def test_a_provider_result_cannot_claim_an_unused_section(
        self, settings: Settings, store: TempArtifactStore
    ) -> None:
        """A provider reporting a face result for API 1 is a wiring bug.

        It would put `verified: false` on screen for a method with no face, which
        the user would read as a failed face check.
        """
        from app.domain.enums import VerificationMethod, VerificationStatus
        from app.integrations.camdx.verify import VerificationOutcome

        service = KycService(store, camdx_mode="mock")
        ref = store.put(b"card", media_type="image/jpeg").handle

        outcome = await service.verify(
            method=VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE,
            identity=FULL_IDENTITY,
            id_card_ref=ref,
            current_face_ref=ref,
            liveness_ref=None,
        )
        # `b"card"` is not an image, so the local face comparison cannot produce a
        # positive result — verification must report partial, not success.
        assert outcome.status is VerificationStatus.PARTIAL
        assert outcome.face is None

        rogue = VerificationOutcome(
            status=VerificationStatus.SUCCESS,
            method=VerificationMethod.VERIFY_USER_INFO,
            face=False,
        )
        with pytest.raises(AppError) as raised:
            service._assert_outcome_matches_method(VerificationMethod.VERIFY_USER_INFO, rogue)

        # The user-facing text for this is deliberately generic (§28), so the code
        # is what we assert on.
        assert raised.value.code is ErrorCode.INTERNAL_ERROR
