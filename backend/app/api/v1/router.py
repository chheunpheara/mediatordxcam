"""Versioned API router.

Only the health routes exist in Phase 1. KYC, liveness and passport routers are
registered by the phase that implements them, so `/docs` never advertises an
endpoint that does not work.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints import health

api_router = APIRouter()
api_router.include_router(health.router)
