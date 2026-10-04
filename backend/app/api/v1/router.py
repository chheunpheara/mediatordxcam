"""Versioned API router.

Registered per phase, so `/docs` never advertises an endpoint that does not work.
Phase 3 adds ID-card processing and Phase 5 adds the verification methods and
verify endpoints; liveness and passport routers arrive with the
phases that implement them.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints import artifacts, health, id_card, verification

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(id_card.router)
api_router.include_router(artifacts.router)
api_router.include_router(verification.router)
