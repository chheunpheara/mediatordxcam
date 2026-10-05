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

#: Variables that exist in `.env.example` but are deliberately not inputs to the
#: `app` container's `Settings`. Each needs a stated reason, so the exclusion is
#: a decision rather than an oversight.
NOT_CONTAINER_ENV = {
    # Build-time Vite input, baked into the bundle by the frontend Docker stage.
    # It never reaches a running container.
    "VITE_API_BASE_URL",
    # PostgreSQL's own bootstrapping variables. The `postgres` service consumes
    # them; the app only ever sees the assembled DATABASE_URL (D13).
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
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


def test_postgres_starts_with_the_default_stack() -> None:
    """`docker compose up` starts the whole product, database included (D13).

    Verification compares against stored sample records, so PostgreSQL is a
    dependency of the default stack rather than a profile someone must remember
    to enable. A `profiles` key on any of the three would split the stack into
    a configuration where verification silently falls back to fixtures.
    """
    services = _load_compose()["services"]

    # Absent `profiles` means "always start".
    assert "profiles" not in services["postgres"]
    assert "profiles" not in services["app"]
    assert "profiles" not in services["frontend"]


def test_app_waits_for_postgres_and_uses_the_in_network_dsn() -> None:
    """The registry connection must be race-free and container-local (D13).

    `service_healthy` stops the app from racing PostgreSQL's first-boot
    initialisation, and the DSN must address the `postgres` service on the
    compose network — the host's `DATABASE_URL` points at localhost, which
    inside the app container is the app container itself.
    """
    app = _load_compose()["services"]["app"]

    assert app["depends_on"]["postgres"]["condition"] == "service_healthy"
    dsn = str(app["environment"]["DATABASE_URL"])
    assert dsn.startswith("postgresql+psycopg://")
    assert "@postgres:5432/" in dsn
    assert "localhost" not in dsn


def test_backend_image_installs_the_registry_driver() -> None:
    """The app imports SQLAlchemy unconditionally, so the image must ship it (D13)."""
    backend_dockerfile = (BACKEND_ROOT / "Dockerfile").read_text()

    assert '".[vision,db]"' in backend_dockerfile


def test_the_stack_is_frontend_plus_backend() -> None:
    """Exactly three services: `app` (API), `frontend` (SPA) and `postgres` (D13).

    The trio is the architecture, not an implementation detail: `frontend` is the
    only container the browser addresses, `app` is the only one that holds
    configuration, and `postgres` is the registry `app` verifies against. A
    fourth service appearing here means one of those boundaries moved without
    the contract noticing.
    """
    services = _load_compose()["services"]

    assert set(services) == {"app", "frontend", "postgres"}


def test_frontend_and_backend_publish_separate_ports() -> None:
    """The two services must be reachable on their own host ports.

    This is the whole point of the split: :3000 for the SPA, :8000 for the API.
    Publishing the same port twice would make one of the services unreachable
    with an error that only appears at `docker compose up` time.
    """
    services = _load_compose()["services"]

    assert "3000:80" in services["frontend"]["ports"]
    assert "8000:8000" in services["app"]["ports"]


def test_the_frontend_holds_no_configuration() -> None:
    """The browser-facing container must never receive credentials (§30).

    nginx serves static files and proxies; it needs no CamDX credential, no
    logging flag, no storage path. Granting it an `environment:` block would put
    secrets in a container that has no reason to read them, and the next
    variable added there would be easy to mistake for backend configuration.
    """
    frontend = _load_compose()["services"]["frontend"]
    environment = frontend.get("environment") or {}

    assert not environment, "frontend must not be configured; all settings belong to app"
    assert not frontend.get("volumes"), "frontend must not mount the biometric volume"


def test_the_app_serves_no_spa() -> None:
    """The API image must be API-only; the SPA lives in the frontend image.

    Both directions matter. A `dist` inside the app image would resurrect a
    second, divergent copy of the frontend behind :8000 — two origins serving
    different bundles. Conversely the frontend image must still build and serve
    the SPA, or :3000 would answer with a 404 for the product itself.
    """
    backend_dockerfile = (BACKEND_ROOT / "Dockerfile").read_text()
    frontend_dockerfile = (BACKEND_ROOT.parent / "frontend" / "Dockerfile").read_text()

    assert "--from=frontend" not in backend_dockerfile
    assert "./static" not in backend_dockerfile
    assert "npm run build" in frontend_dockerfile
    assert "/app/dist" in frontend_dockerfile
