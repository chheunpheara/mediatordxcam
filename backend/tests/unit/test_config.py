"""Configuration loading and validation (§22)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import (
    CamDXMode,
    Settings,
    get_settings,
)
from app.core.errors import ConfigurationError, ErrorCode


def test_defaults_are_safe_for_development() -> None:
    settings = Settings(_env_file=None)

    assert settings.camdx_mode is CamDXMode.MOCK
    assert settings.log_sensitive_payloads is False
    assert settings.camdx_expose_developer_view is False
    # No registry by default: verification runs on bundled fixtures (D13), so a
    # fresh checkout works with no database running.
    assert settings.database_url is None


def test_an_empty_database_url_selects_fixtures_not_a_broken_dsn() -> None:
    """`.env.example` ships `DATABASE_URL=`; tests force the same empty value.

    An empty string has to mean "unset" — a DSN of `""` would fail to parse at
    the first connection and turn "fixtures selected" into a startup error.
    """
    settings = Settings(_env_file=None, database_url="  ")

    assert settings.database_url is None


def test_environment_overrides_are_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAMDX_MODE", "mock")
    monkeypatch.setenv("CAMDX_TIMEOUT", "45")
    monkeypatch.setenv("TEMP_ARTIFACT_TTL_SECONDS", "1200")

    settings = Settings(_env_file=None)

    assert settings.camdx_timeout == 45.0
    assert settings.temp_artifact_ttl_seconds == 1200


def test_cors_origins_accept_a_comma_separated_string(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173, https://kyc.example.com")

    settings = Settings(_env_file=None)

    assert settings.cors_origins == ["http://localhost:5173", "https://kyc.example.com"]


def test_secrets_are_wrapped_so_they_cannot_be_logged_by_accident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAMDX_CLIENT_SECRET", "s3cr3t-value-that-must-not-leak")

    settings = Settings(_env_file=None)

    assert settings.camdx_client_secret is not None
    # A bare str would be printed by any repr/str/format of the settings object.
    assert "s3cr3t-value-that-must-not-leak" not in repr(settings)


def test_real_mode_requires_complete_credentials() -> None:
    settings = Settings(_env_file=None, camdx_mode="real")

    assert settings.is_real_camdx is True
    assert settings.camdx_credentials_present() is False

    with pytest.raises(ConfigurationError) as excinfo:
        settings.require_real_camdx_credentials()

    message = str(excinfo.value)
    assert excinfo.value.code == ErrorCode.CONFIGURATION_ERROR
    assert "CAMDX_BASE_URL" in message
    assert "CAMDX_CLIENT_ID" in message


def test_real_mode_is_satisfied_by_a_complete_credential_set() -> None:
    settings = Settings(
        _env_file=None,
        camdx_mode="real",
        camdx_base_url="https://camdx.example.com",
        camdx_client_id="id",
        camdx_client_secret="secret",
    )

    settings.require_real_camdx_credentials()


def test_a_cors_wildcard_is_rejected_in_any_environment() -> None:
    settings = Settings(_env_file=None, camdx_mode="mock", cors_origins=["*"])

    with pytest.raises(ConfigurationError) as excinfo:
        settings.validate_startup()

    assert excinfo.value.code == ErrorCode.CONFIGURATION_ERROR
    assert "wildcard" in str(excinfo.value)


def test_mock_mode_does_not_require_credentials() -> None:
    settings = Settings(_env_file=None, camdx_mode="mock")

    settings.validate_startup()


@pytest.mark.parametrize(
    "field", ["camdx_timeout", "max_upload_bytes", "temp_artifact_ttl_seconds"]
)
def test_bounds_are_enforced(field: str) -> None:
    with pytest.raises(ValidationError):
        Settings(**{field: -1})


def test_temp_storage_defaults_outside_the_package() -> None:
    settings = Settings(_env_file=None)

    assert settings.temp_storage_dir.is_absolute()
    assert settings.temp_storage_dir.name == "tmp"
    assert "app" not in settings.temp_storage_dir.parts


def test_get_settings_is_cached() -> None:
    get_settings.cache_clear()
    first = get_settings()
    assert get_settings() is first
