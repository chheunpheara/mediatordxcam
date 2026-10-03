"""Error taxonomy and envelope construction (§28)."""

from __future__ import annotations

import pytest

from app.core.errors import (
    DEFAULT_STATUS,
    USER_MESSAGES,
    AppError,
    ArtifactNotFoundError,
    ErrorCode,
    RequirementsNotMetError,
    error_envelope,
)


def test_every_code_has_a_message_and_a_status() -> None:
    for code in ErrorCode:
        assert code in USER_MESSAGES, f"{code} has no user message"
        assert code in DEFAULT_STATUS, f"{code} has no HTTP status"


def test_messages_are_written_for_a_person() -> None:
    for code, message in USER_MESSAGES.items():
        assert message, f"{code} has an empty message"
        assert not message.isupper(), f"{code} message is shouting at the user"
        assert message[0].isupper(), f"{code} message does not start as a sentence"


@pytest.mark.parametrize(
    "code",
    [
        ErrorCode.IDENTITY_NOT_VERIFIED,
        ErrorCode.FACE_NOT_VERIFIED,
        ErrorCode.OCR_UNREADABLE,
        ErrorCode.LIVENESS_FAILED,
    ],
)
def test_section_messages_match_the_specified_wording(code: ErrorCode) -> None:
    assert USER_MESSAGES[code].endswith(".")


def test_verification_outcomes_are_not_http_5xx() -> None:
    # A mismatch is a successful call with a negative result, not a server fault.
    for code in (
        ErrorCode.IDENTITY_NOT_VERIFIED,
        ErrorCode.FACE_NOT_VERIFIED,
        ErrorCode.LIVENESS_FAILED,
        ErrorCode.ID_CARD_NOT_VERIFIED,
    ):
        assert DEFAULT_STATUS[code] == 422


def test_upstream_faults_are_translated_to_gateway_statuses() -> None:
    assert DEFAULT_STATUS[ErrorCode.UPSTREAM_TIMEOUT] == 504
    assert DEFAULT_STATUS[ErrorCode.UPSTREAM_UNAVAILABLE] == 502
    assert DEFAULT_STATUS[ErrorCode.UPSTREAM_BAD_RESPONSE] == 502


def test_envelope_exposes_no_technical_detail() -> None:
    error = AppError(ErrorCode.IMAGE_UNREADABLE)

    envelope = error_envelope(error, request_id="req_abc")

    assert envelope["error"]["code"] == "IMAGE_UNREADABLE"
    assert envelope["error"]["requestId"] == "req_abc"
    assert "detail" not in envelope["error"]
    assert envelope["error"]["fieldErrors"] == {}


def test_internal_detail_is_opt_in() -> None:
    error = AppError(ErrorCode.INTERNAL_ERROR)

    with_detail = error_envelope(error, request_id="req_abc", include_internal_detail=True)

    assert "detail" in with_detail["error"]


def test_requirements_error_lists_unsatisfied_flags() -> None:
    error = RequirementsNotMetError(
        missing=["currentFace"],
        field_errors={"currentFaceArtifactHandle": "Please take a photo of your face."},
    )

    envelope = error_envelope(error, request_id="req_abc")

    assert envelope["error"]["code"] == "REQUIREMENTS_NOT_MET"
    assert envelope["error"]["missing"] == ["currentFace"]
    assert "currentFaceArtifactHandle" in envelope["error"]["fieldErrors"]


@pytest.mark.parametrize(
    ("expired", "expected"),
    [(False, ErrorCode.ARTIFACT_NOT_FOUND), (True, ErrorCode.ARTIFACT_EXPIRED)],
)
def test_artifact_errors_distinguish_missing_from_expired(
    expired: bool, expected: ErrorCode
) -> None:
    assert ArtifactNotFoundError(expired=expired).code == expected


def test_custom_message_is_used_verbatim() -> None:
    error = AppError(ErrorCode.IMAGE_TOO_LARGE, message="The image is too large.")

    assert error.message == "The image is too large."


def test_unknown_code_falls_back_instead_of_leaking() -> None:
    error = AppError(code="SOME_VENDOR_SPECIFIC_CODE")  # type: ignore[arg-type]

    assert error.code is ErrorCode.INTERNAL_ERROR
    assert error.http_status == 500
