# syntax=docker/dockerfile:1
#
# Single image serving both the API and the built SPA, so production is
# single-origin: the browser never needs a second host, and there is no CORS
# surface (§30).
#
# Build context is the REPOSITORY ROOT, not backend/:
#
#     docker build -f backend/Dockerfile -t camdx-kyc-backend .
#
# docker-compose.yml already does this.

# ─── Frontend build ───────────────────────────────────────────────────────────
FROM node:22-slim AS frontend

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm run build

# ─── Backend base ─────────────────────────────────────────────────────────────
# Pinned to 3.12 for reproducible OpenCV/numpy wheels regardless of the host
# interpreter (implementation-plan.md D12).
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libglib/libgl are needed by OpenCV even in the headless build on slim; curl is
# used by the healthcheck.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        libglib2.0-0 \
        libgl1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Backend builder ──────────────────────────────────────────────────────────
FROM base AS builder

COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install ".[vision]"

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

# Non-root: nothing here needs write access outside the temp storage directory.
RUN groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --create-home --home-dir /home/app app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY --chown=app:app backend/app ./app
COPY --from=frontend --chown=app:app /app/dist ./static

# Temp biometric storage (§29). A named volume, so biometric bytes never enter an
# image layer and never reach a served directory. Mode 0700: only the app user
# may list or read artefacts. Docker copies these permissions into a named volume
# on first creation.
RUN mkdir -p /app/var/tmp \
    && chown -R app:app /app/var \
    && chmod 700 /app/var/tmp

ENV APP_ENV=docker \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000 \
    TEMP_STORAGE_DIR=/app/var/tmp

USER app
EXPOSE 8000

# Liveness only. A slow or unavailable dependency must not trigger a restart
# loop; that is what readiness is for (§36).
# 127.0.0.1, not `localhost`: uvicorn binds IPv4, and curl resolves `localhost`
# to ::1 first on some bases.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]