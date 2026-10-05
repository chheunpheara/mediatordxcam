# syntax=docker/dockerfile:1
#
# API-only image: FastAPI on :8000, no static files.
#
# The SPA is built and served by the separate `frontend` container (nginx on
# :3000, which proxies /api back to this service), so this image never contains
# a copy of the browser bundle and `app/main.py` registers no static routes when
# it runs here. Nothing under /app is publicly served — artefacts are reachable
# only through the handle-checked API route (§29, D8).
#
# Build context is the BACKEND directory:
#
#     docker build -t camdx-kyc-backend .
#
# docker-compose.yml already does this.

# ─── Base ─────────────────────────────────────────────────────────────────────
# Pinned to 3.12 for reproducible OpenCV/numpy wheels regardless of the host
# interpreter (implementation-plan.md D12).
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libglib/libgl are needed by OpenCV even in the headless build on slim; tesseract
# performs the local ID-card OCR; curl is used by the healthcheck.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        libglib2.0-0 \
        libgl1 \
        tesseract-ocr \
        tesseract-ocr-khm \
        tesseract-ocr-eng \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM base AS builder

COPY pyproject.toml ./
COPY app ./app
# `vision` = OpenCV/tesseract (face + local OCR); `db` = SQLAlchemy + psycopg,
# the identity registry this backend verifies against (D13).
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install ".[vision,db]"

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

# Non-root: nothing here needs write access outside the temp storage directory.
RUN groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --create-home --home-dir /home/app app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY --chown=app:app app ./app

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
