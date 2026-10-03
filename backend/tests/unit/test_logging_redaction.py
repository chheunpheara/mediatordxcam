"""Log redaction (§29).

Every assertion here is a "this value must not appear" check. Together they cover
the classes of leak the spec names: biometric bytes, identity values, artefact
paths, upstream payload text and credentials.
"""

from __future__ import annotations

import io
import logging

import pytest

from app.core.logging import (
    RedactingFilter,
    configure_logging,
    redact,
    register_sensitive_values,
)


@pytest.fixture(autouse=True)
def _clear_registered_values() -> None:
    import app.core.logging as logging_module

    logging_module._SENSITIVE_VALUES.clear()
    yield
    logging_module._SENSITIVE_VALUES.clear()


@pytest.fixture
def captured() -> tuple[logging.Logger, io.StringIO]:
    """A logger wired to an in-memory stream with redaction installed."""
    stream = io.StringIO()
    logger = logging.getLogger("camdx.test")
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.DEBUG)

    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactingFilter())
    from app.core.logging import JsonFormatter

    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    return logger, stream


def test_national_id_is_redacted_from_the_message() -> None:
    assert "012345678" not in redact("verifying national id 012345678")


def test_national_id_is_redacted_from_format_arguments(
    captured: tuple[logging.Logger, io.StringIO],
) -> None:
    logger, stream = captured

    logger.info("verifying %s for method %s", "012345678", "verify_user_info")

    assert "012345678" not in stream.getvalue()
    assert "verify_user_info" in stream.getvalue()


def test_artefact_handles_are_truncated() -> None:
    text = redact("stored art_9c1e77a0f3b24d5e into store")

    assert "9c1e77a0f3b24d5e" not in text
    assert "art_" not in text


def test_temp_paths_are_redacted() -> None:
    text = redact("wrote /srv/app/backend/var/tmp/art_9c1e77a0.jpg")

    assert "var/tmp" not in text
    assert ".jpg" not in text


def test_bearer_tokens_are_redacted() -> None:
    text = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")

    assert "eyJhbGciOiJIUzI1NiJ9" not in text


def test_registered_secrets_are_redacted_even_in_a_sentence() -> None:
    register_sensitive_values(["super-secret-client-value"])

    text = redact("authenticating with super-secret-client-value now")

    assert "super-secret-client-value" not in text


def test_short_values_are_not_registered() -> None:
    # Redacting a 3-char string would corrupt unrelated text and protect nothing.
    register_sensitive_values(["abc"])

    assert redact("abc") == "abc"


@pytest.mark.parametrize(
    "key",
    [
        "national_id",
        "first_name_english",
        "date_of_birth",
        "client_secret",
        "image_bytes",
        "artifact_path",
    ],
)
def test_sensitive_extra_fields_are_replaced(
    captured: tuple[logging.Logger, io.StringIO], key: str
) -> None:
    logger, stream = captured

    logger.info("structured", extra={key: "sensitive-value"})

    assert "sensitive-value" not in stream.getvalue()


def test_allowed_fields_survive(captured: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = captured

    logger.info("request", extra={"request_id": "req_abc123", "status": 200})

    output = stream.getvalue()
    assert "req_abc123" in output
    assert '"status": 200' in output


def test_payload_logging_is_disabled_by_default() -> None:
    configure_logging(level="DEBUG", allow_sensitive_payloads=False, force=True)

    assert logging.getLogger("camdx.payload").disabled is True


def test_payload_logging_can_be_enabled_explicitly() -> None:
    configure_logging(level="DEBUG", allow_sensitive_payloads=True, force=True)

    assert logging.getLogger("camdx.payload").disabled is False
