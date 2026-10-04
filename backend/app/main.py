"""FastAPI application factory.

Phase 1 scope: app construction, middleware, error handlers, health routes,
static SPA serving. Everything domain-related arrives in later phases.

Two invariants this module is responsible for:

* **No technical text escapes** (§28). Every failure leaves through the envelope
  registered by `core.errors`.
* **No sensitive data is logged** (§29). The redaction filter is installed on the
  root logger, and no user payload is logged at any level.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.base import RequestResponseEndpoint
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.v1.router import api_router
from app.core.config import AppEnvironment, Settings, get_settings
from app.core.errors import AppError, ErrorCode, error_envelope, register_exception_handlers
from app.core.ids import REQUEST_ID_HEADER, new_request_id
from app.core.logging import configure_logging, register_sensitive_values
from app.services.artifacts import TempArtifactStore

#: Every route below this prefix returns data derived from an identity document.
#: Used to apply the no-store policy in one place rather than per endpoint.
API_PREFIX = "/api/"

logger = logging.getLogger("camdx.app")

#: Built SPA assets, present in the production image only. In development Vite
#: serves the frontend and proxies /api here instead.
STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


def _configure_observability(settings: Settings) -> None:
    """Install logging, register secrets for redaction, verify configuration."""
    configure_logging(
        level=settings.log_level,
        allow_sensitive_payloads=settings.log_sensitive_payloads,
    )
    register_sensitive_values(
        [
            settings.camdx_base_url,
            settings.camdx_client_id.get_secret_value() if settings.camdx_client_id else None,
            settings.camdx_client_secret.get_secret_value()
            if settings.camdx_client_secret
            else None,
            settings.camdx_api_key.get_secret_value() if settings.camdx_api_key else None,
        ]
    )
    # Fail loudly at startup rather than silently serving mock results (§21).
    settings.validate_startup()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start-up and shut-down hooks.

    Starts the temp-artefact sweeper (§29) so biometric files are deleted on a
    timer even if no request ever touches them again. On shut-down it sweeps once
    more and clears the directory, so a stopped container leaves nothing behind.
    """
    settings: Settings = app.state.settings
    _configure_observability(settings)
    logger.info(
        "startup",
        extra={"environment": str(settings.app_env), "camdx_mode": str(settings.camdx_mode)},
    )

    store = TempArtifactStore(
        settings.temp_storage_dir,
        ttl_seconds=settings.temp_artifact_ttl_seconds,
    )
    sweeper = asyncio.create_task(_sweep_loop(store, settings))
    try:
        yield
    finally:
        sweeper.cancel()
        with suppress(asyncio.CancelledError):
            await sweeper
        # Remove everything on the way out: a stopped container must not leave
        # biometric files on a volume that outlives it.
        store.clear()
        logger.info("shutdown")


async def _sweep_loop(store: TempArtifactStore, settings: Settings) -> None:
    """Delete expired artefacts on a timer until cancelled."""
    interval = settings.temp_sweep_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(store.sweep)
        except Exception:  # pragma: no cover - defensive
            # A sweep failure must not kill the app; the next tick retries.
            logger.exception("artefact sweep failed")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build and configure the application.

    Args:
        settings: Configuration override. Tests pass an explicit instance; the
            running process uses the cached one.

    Returns:
        A fully wired `FastAPI` instance.
    """
    resolved = settings or get_settings()

    app = FastAPI(
        title="CamDX KYC Verification API",
        description=(
            "Application API for the CamDX KYC verification product. "
            "CamDigiKey is reached only from this backend; the browser never "
            "communicates with it directly."
        ),
        version=resolved.app_version,
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = resolved

    # CORS: explicit allow-list only. Wildcards are rejected in production by
    # `require_real_camdx_credentials`, and credentials are never allowed since
    # the API is cookie- and token-free (§29, §30).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", REQUEST_ID_HEADER],
        expose_headers=[REQUEST_ID_HEADER],
        max_age=600,
    )

    if resolved.is_production:
        app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=[*resolved.cors_origins, "localhost", "127.0.0.1"],
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Attach a correlation id, a structured access log line, and cache policy.

        Only route, method, status and duration are logged — never a body, a
        query parameter or a header value (§29).

        API responses are marked uncacheable here rather than per endpoint. Every
        API response can carry identity data or an artefact handle, and a handle
        stops resolving the moment its artefact expires — so a cached copy would
        outlive both the data and the consent to keep it. Setting this once means
        a new endpoint cannot forget to.
        """
        request_id = request.headers.get(REQUEST_ID_HEADER) or new_request_id()
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id
        if request.url.path.startswith(API_PREFIX):
            response.headers["Cache-Control"] = "no-store, private"
            response.headers["Pragma"] = "no-cache"
        logger.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
            },
        )
        return response

    register_exception_handlers(
        app, expose_internal_detail=resolved.app_env is AppEnvironment.LOCAL
    )

    app.include_router(api_router)

    if STATIC_DIR.is_dir():
        # The built SPA is served here so one origin backs the whole product in
        # production. This mount serves *application assets only* — no user
        # upload is ever written under STATIC_DIR (§29, D8).
        from fastapi.staticfiles import StaticFiles

        assets_dir = STATIC_DIR / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa_shell(full_path: str, request: Request) -> Response:
            """Serve the SPA shell for any non-API path.

            Client-side routing means a user who bookmarks or refreshes
            `/id-card` requests that path directly. A plain static mount answers
            404 and the app appears broken, so the shell is returned instead.

            The `/api` prefix is excluded explicitly. An unmatched API path must
            fall through to the API's own 404 envelope — returning HTML there
            would turn an API error into a parse failure in the client (§28).
            """
            if request.url.path.startswith("/api/"):
                return JSONResponse(
                    status_code=status.HTTP_404_NOT_FOUND,
                    content=error_envelope(
                        AppError(ErrorCode.NOT_FOUND), request_id=request.state.request_id
                    ),
                )

            index = STATIC_DIR / "index.html"
            if not index.is_file():
                return Response(
                    content="Frontend assets are not available.",
                    status_code=status.HTTP_404_NOT_FOUND,
                    media_type="text/plain",
                )
            return FileResponse(index, headers={"Cache-Control": "no-store"})

    return app


app = create_app()
