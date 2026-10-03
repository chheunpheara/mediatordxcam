"""Health endpoints over ASGI transport (§36 Phase 1 acceptance)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from pydantic import SecretStr

from app.core.ids import REQUEST_ID_HEADER


async def test_liveness_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readiness_reports_non_secret_configuration(client: AsyncClient) -> None:
    response = await client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "camdx-kyc-backend"
    assert body["environment"] == "local"
    assert body["camdxMode"] == "mock"
    assert body["time"].endswith("+00:00") or body["time"].endswith("Z")


async def test_readiness_never_exposes_a_credential(app: FastAPI, client: AsyncClient) -> None:
    app.state.settings = app.state.settings.model_copy(
        update={"camdx_client_secret": SecretStr("super-secret-value")}
    )

    response = await client.get("/api/v1/health")

    assert "super-secret-value" not in response.text


async def test_request_id_is_echoed(client: AsyncClient) -> None:
    response = await client.get("/health", headers={REQUEST_ID_HEADER: "req_caller_supplied"})

    assert response.headers[REQUEST_ID_HEADER] == "req_caller_supplied"


async def test_request_id_is_generated_when_absent(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.headers[REQUEST_ID_HEADER].startswith("req_")


async def test_unknown_route_returns_the_error_envelope(client: AsyncClient) -> None:
    response = await client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "NOT_FOUND"
    assert body["error"]["message"]
    assert body["error"]["requestId"].startswith("req_")
    # A 404 must not leak the router's internal phrasing.
    assert "Not Found" not in body["error"]["message"]


async def test_openapi_document_is_served(client: AsyncClient) -> None:
    response = await client.get("/openapi.json")

    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/health" in paths
    assert "/api/v1/health" in paths


@pytest.mark.parametrize("path", ["/health", "/api/v1/health"])
async def test_no_response_leaks_a_secret(client: AsyncClient, path: str) -> None:
    response = await client.get(path)

    for marker in ("camdx_client_secret", "Authorization", "traceback", "Traceback"):
        assert marker not in response.text
