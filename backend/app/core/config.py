"""Application configuration.

This module is the single definition of every environment variable the backend
understands (§22). Nothing else in the codebase may read `os.environ` directly:
services and adapters receive an injected `Settings`, so tests can override
behaviour deterministically instead of mutating process state.

Credentials are read here and nowhere else. They are never logged, never
serialised into a response, and never returned from an endpoint (§30).
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Repository root: backend/app/core/config.py -> backend/
BACKEND_ROOT: Path = Path(__file__).resolve().parents[2]
REPO_ROOT: Path = BACKEND_ROOT.parent

MIB: int = 1024 * 1024


class AppEnvironment(StrEnum):
    """Deployment environment. Controls safe defaults, not behaviour."""

    LOCAL = "local"
    DOCKER = "docker"
    STAGING = "staging"
    PRODUCTION = "production"


class CamDXMode(StrEnum):
    """Which CamDigiKey implementation is active (§21).

    Mock and real implementations never share a code path. The value selects a
    different adapter class; it does not branch inside one.
    """

    MOCK = "mock"
    REAL = "real"


class Settings(BaseSettings):
    """Typed application settings loaded from the environment."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        frozen=True,
    )

    # -- Application -------------------------------------------------------
    app_name: str = Field(default="camdx-kyc-backend", description="Service name.")
    app_version: str = Field(default="0.1.0", description="Service version.")
    app_env: AppEnvironment = Field(
        default=AppEnvironment.LOCAL, description="Deployment environment."
    )
    app_host: str = Field(default="0.0.0.0", description="Bind address.")  # noqa: S104
    app_port: int = Field(default=8000, ge=1, le=65535, description="Bind port.")

    # -- Logging (§29) -----------------------------------------------------
    log_level: str = Field(default="INFO", description="Root log level.")
    log_sensitive_payloads: bool = Field(
        default=False,
        description=(
            "Allows request/response payloads in logs. UNSAFE. Never enable in a "
            "shared or production environment (§29)."
        ),
    )

    # -- CamDX (§21, §22) --------------------------------------------------
    camdx_mode: CamDXMode = Field(
        default=CamDXMode.MOCK, description="Selects the CamDX provider implementation."
    )
    camdx_base_url: str | None = Field(
        default=None, description="CamDigiKey base URL. Required when mode is real."
    )
    camdx_client_id: SecretStr | None = Field(
        default=None, description="CamDigiKey client id. Never logged."
    )
    camdx_client_secret: SecretStr | None = Field(
        default=None, description="CamDigiKey client secret. Never logged."
    )
    camdx_api_key: SecretStr | None = Field(
        default=None, description="CamDigiKey API key, if the integration requires one."
    )
    camdx_timeout: float = Field(default=30.0, gt=0, le=300, description="Seconds.")
    camdx_expose_developer_view: bool = Field(
        default=False,
        description=(
            "Adds a developer-only block (scores, upstream codes) to normalized "
            "results. Off in any user-facing environment (§24)."
        ),
    )

    ocr_provider: str = Field(
        default="mock",
        description=(
            "Mock fixtures (`mock`) or real capture via local Tesseract (`tesseract`). "
            "Tesseract performs OCR on the real uploaded bytes; it never calls CamDX."
        ),
    )
    ocr_languages: str = Field(default="eng+khm", description="Tesseract language codes.")
    ollama_base_url: str | None = Field(
        default=None,
        description="Local Ollama server for NLP field extraction. Never calls CamDX.",
    )
    ollama_model: str = Field(
        default="llama3.1", description="Ollama model for OCR field extraction."
    )

    # -- HTTP / CORS -------------------------------------------------------
    # `NoDecode` disables pydantic-settings' JSON pre-parsing for this field so a
    # plain comma-separated env value works without JSON quoting.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"],
        description="Explicit allow-list. Wildcards are rejected in production.",
    )

    # -- Uploads (§7, §29) -------------------------------------------------
    max_upload_bytes: int = Field(
        default=10 * MIB, gt=0, description="Hard cap enforced while streaming the body."
    )
    min_image_width: int = Field(default=640, ge=1, description="Minimum width in px.")
    min_image_height: int = Field(default=480, ge=1, description="Minimum height in px.")

    # -- Temporary artefact storage (§29) ----------------------------------
    temp_storage_dir: Path = Field(
        default=BACKEND_ROOT / "var" / "tmp",
        description="Biometric temp storage. Must never sit under a static mount.",
    )
    temp_artifact_ttl_seconds: int = Field(
        default=900, ge=30, le=3600, description="Biometric artefact lifetime."
    )
    temp_sweep_interval_seconds: int = Field(
        default=60, ge=5, description="Temp artefact sweeper cadence."
    )

    # -- Database (§4, D13) ------------------------------------------------
    # The sample identity records verification compares against. Unset (or
    # empty) selects fixture verification — no database, no connection, which
    # is the default and what every test runs on.
    database_url: str | None = Field(
        default=None,
        description=(
            "DSN for the identity registry (D13). Empty/unset = fixture "
            "verification. Compose injects the in-network value itself."
        ),
    )

    # -- Validators --------------------------------------------------------
    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("log_level")
    @classmethod
    def _upper_log_level(cls, value: str) -> str:
        return value.upper()

    @field_validator("ocr_provider")
    @classmethod
    def _ocr_provider_supported(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in ("mock", "tesseract"):
            raise ValueError("ocr_provider must be 'mock' or 'tesseract'")
        return value

    @field_validator("database_url", mode="before")
    @classmethod
    def _empty_database_url_is_unset(cls, value: object) -> object:
        """`DATABASE_URL=` means "no registry", not a DSN of "".

        `.env.example` ships it empty, tests force it empty, and an empty
        string that later failed to parse as a DSN would turn "fixtures
        selected" into a startup error.
        """
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    # -- Derived helpers ---------------------------------------------------
    @property
    def is_production(self) -> bool:
        return self.app_env is AppEnvironment.PRODUCTION

    @property
    def is_real_camdx(self) -> bool:
        return self.camdx_mode is CamDXMode.REAL

    def camdx_credentials_present(self) -> bool:
        """True when every credential required by real mode is configured.

        Checked before building `RealCamDXProvider` so a misconfigured deployment
        fails loudly at startup rather than silently serving mock results (§21).
        """
        return bool(self.camdx_base_url and self.camdx_client_id and self.camdx_client_secret)

    def require_real_camdx_credentials(self) -> None:
        """Fail fast when real CamDX mode is misconfigured.

        Called during startup for every environment, because a deployment that
        selected `real` must never quietly fall back to mock results (§21).

        Raises:
            ConfigurationError: naming the missing variables, never their values.
        """
        from app.core.errors import ConfigurationError, ErrorCode

        if not self.is_real_camdx:
            return

        missing = [
            name
            for name, value in (
                ("CAMDX_BASE_URL", self.camdx_base_url),
                ("CAMDX_CLIENT_ID", self.camdx_client_id),
                ("CAMDX_CLIENT_SECRET", self.camdx_client_secret),
            )
            if not value
        ]
        if missing:
            raise ConfigurationError(
                message="CAMDX_MODE=real requires " + ", ".join(missing) + ".",
                code=ErrorCode.CONFIGURATION_ERROR,
            )

    def validate_startup(self) -> None:
        """Run every startup validation.

        Raises:
            ConfigurationError: on the first invalid setting found.
        """
        from app.core.errors import ConfigurationError, ErrorCode

        self.require_real_camdx_credentials()

        if "*" in self.cors_origins:
            # A wildcard would let any origin drive the verification flow, and
            # the origin is the entire access boundary for artefact handles (§29).
            raise ConfigurationError(
                message="CORS_ORIGINS must list explicit origins; wildcards are not allowed.",
                code=ErrorCode.CONFIGURATION_ERROR,
            )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings instance.

    Cached so configuration is parsed once. Tests that need to vary settings
    clear the cache via `get_settings.cache_clear()` or construct `Settings`
    directly with overrides.
    """
    return Settings()
