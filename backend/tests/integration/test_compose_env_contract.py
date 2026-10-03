"""Guards the container environment contract.

Compose only forwards variables that appear in a service's `environment:` block.
A variable present in `.env.example` and defined in `Settings` but missing from
that block is silently dropped: the container starts, the app looks configured,
and the setting does nothing. That failure is invisible until behaviour diverges
from local development, so it is asserted here instead.

The reverse direction matters too — a variable forwarded by compose but unknown to
`Settings` is dead configuration.
"""

from __future__ import annotations

import re

import pytest
import yaml

from app.core.config import BACKEND_ROOT, Settings

REPO_ROOT = BACKEND_ROOT.parent
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"
ENV_EXAMPLE = REPO_ROOT / ".env.example"

#: Variables that exist in `.env.example` but are deliberately not runtime
#: container inputs. Each needs a stated reason, so the exclusion is a decision
#: rather than an oversight.
NOT_CONTAINER_ENV = {
    # Build-time Vite input, baked into the bundle by the frontend Docker stage.
    # It never reaches a running container.
    "VITE_API_BASE_URL",
}


def _load_compose() -> dict:
    return yaml.safe_load(COMPOSE_FILE.read_text())


def _settings_fields() -> set[str]:
    """Uppercase env-var names for every `Settings` field.

    Derived from the model rather than hand-maintained, so a new setting cannot be
    added without this test noticing.
    """
    return {name.upper() for name in Settings.model_fields}


def _app_environment() -> set[str]:
    compose = _load_compose()
    env = compose["services"]["app"]["environment"]
    return set(env) if isinstance(env, dict) else set()


def _env_example_keys() -> set[str]:
    keys = set()
    for line in ENV_EXAMPLE.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        keys.add(stripped.split("=", 1)[0].strip())
    return keys


def test_compose_file_is_parseable() -> None:
    assert _load_compose()["services"]["app"]


@pytest.mark.parametrize("name", sorted(_settings_fields() - NOT_CONTAINER_ENV))
def test_every_setting_is_forwarded_to_the_container(name: str) -> None:
    assert name in _app_environment(), (
        f"{name} is defined in Settings but not in the compose `environment:` block, "
        "so setting it in .env has no effect inside the container"
    )


def test_compose_forwards_nothing_unknown_to_settings() -> None:
    unknown = _app_environment() - _settings_fields()

    assert not unknown, f"compose forwards {sorted(unknown)}, which Settings does not define"


@pytest.mark.parametrize("name", sorted(_env_example_keys() - NOT_CONTAINER_ENV))
def test_every_documented_variable_is_a_real_setting(name: str) -> None:
    assert name in _settings_fields(), (
        f"{name} appears in .env.example but Settings has no such field, "
        "so setting it has no effect anywhere"
    )


def test_secret_variables_are_present_but_default_to_empty() -> None:
    """Credentials must be forwarded yet have no default value in compose.

    A hard-coded default here would be a committed secret (§22).
    """
    env = _load_compose()["services"]["app"]["environment"]

    for name in ("CAMDX_BASE_URL", "CAMDX_CLIENT_ID", "CAMDX_CLIENT_SECRET", "CAMDX_API_KEY"):
        assert name in env
        assert re.fullmatch(r"\$\{[A-Z_]+:-\}", str(env[name])), (
            f"{name} must default to empty so no credential is committed"
        )


def test_payload_logging_cannot_be_enabled_from_compose() -> None:
    """`LOG_SENSITIVE_PAYLOADS` is hard-off; only the app source may enable it (§29)."""
    env = _load_compose()["services"]["app"]["environment"]

    assert env["LOG_SENSITIVE_PAYLOADS"] == "false"


def test_app_env_is_pinned_to_docker() -> None:
    """The container must not be configurable into `local`.

    `local` enables internal detail in error envelopes, so honouring an `APP_ENV`
    from `.env` would leak implementation detail inside Docker (§28).
    """
    env = _load_compose()["services"]["app"]["environment"]

    assert env["APP_ENV"] == "docker"


def test_mock_is_the_default_mode() -> None:
    assert _load_compose()["services"]["app"]["environment"]["CAMDX_MODE"] == "${CAMDX_MODE:-mock}"


def test_temp_storage_points_at_the_volume_mount() -> None:
    env = _load_compose()["services"]["app"]["environment"]

    assert env["TEMP_STORAGE_DIR"] == "/app/var/tmp"
    assert any("/app/var/tmp" in str(v) for v in _load_compose()["services"]["app"]["volumes"])


def test_healthcheck_probes_ipv4_loopback() -> None:
    """`localhost` resolves to ::1 first; the servers bind IPv4 only."""
    healthcheck = _load_compose()["services"]["app"]["healthcheck"]
    probe = " ".join(healthcheck["test"])

    assert "127.0.0.1" in probe
    assert "localhost" not in probe


def test_postgres_is_opt_in_and_the_app_is_not() -> None:
    """`docker compose up` must start the app alone (§4, D6).

    A service with no `profiles` key runs by default; `postgres` must be behind a
    profile so the default stack stays minimal.
    """
    services = _load_compose()["services"]

    assert "db" in services["postgres"]["profiles"]
    # Absent `profiles` means "always start" — which is what the app must do.
    assert "profiles" not in services["app"]


def test_there_is_exactly_one_frontend_and_it_is_the_app() -> None:
    """No second service may claim to be the frontend.

    A separate frontend container serving the same `dist` the app already serves
    is redundant, and worse, it advertises a second port that nothing listens on
    under a plain `docker compose up` — which reads as a broken build. The SPA is
    served by `app`; Vite on 5173 is the host-side dev loop, not a container.
    """
    services = _load_compose()["services"]

    assert set(services) == {"app", "postgres"}


def test_the_app_serves_the_spa() -> None:
    """The app image must include the built SPA, so one port serves the product."""
    dockerfile = (BACKEND_ROOT / "Dockerfile").read_text()

    assert "--from=frontend" in dockerfile
    assert "./static" in dockerfile
