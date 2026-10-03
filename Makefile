# CamDX KYC Verification — task runner
#
# Every target works both inside Docker and against a local virtualenv, so the
# same command validates a developer's machine and CI.

SHELL := /bin/bash
BACKEND := backend
FRONTEND := frontend
VENV := $(BACKEND)/.venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.DEFAULT_GOAL := help
.PHONY: help setup backend-install frontend-install check \
        backend-test backend-lint backend-format backend-typecheck backend-run \
        frontend-test frontend-lint frontend-typecheck frontend-build frontend-run \
        docker-build docker-up docker-down docker-logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ─── Setup ────────────────────────────────────────────────────────────────────
setup: backend-install frontend-install ## Install all dependencies

backend-install: $(VENV)/.installed ## Create the venv and install the backend
frontend-install: ## Install frontend dependencies
	cd $(FRONTEND) && npm install

$(VENV)/.installed: $(BACKEND)/pyproject.toml
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e "$(BACKEND)[dev]"
	@touch $@

# ─── Validation ───────────────────────────────────────────────────────────────
check: backend-lint backend-format backend-typecheck backend-test \
       frontend-lint frontend-typecheck frontend-test ## Run every check

backend-lint: ## ruff check
	cd $(BACKEND) && .venv/bin/ruff check .

backend-format: ## ruff format --check
	cd $(BACKEND) && .venv/bin/ruff format --check .

backend-typecheck: ## mypy
	cd $(BACKEND) && .venv/bin/mypy app

backend-test: ## pytest
	cd $(BACKEND) && .venv/bin/pytest

frontend-lint: ## eslint
	cd $(FRONTEND) && npm run lint

frontend-typecheck: ## tsc --noEmit
	cd $(FRONTEND) && npm run typecheck

frontend-test: ## vitest
	cd $(FRONTEND) && npm run test

frontend-build: ## Production build (typecheck + bundle)
	cd $(FRONTEND) && npm run build

# ─── Run ──────────────────────────────────────────────────────────────────────
backend-run: ## Start the API with reload on :8000
	cd $(BACKEND) && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend-run: ## Start the Vite dev server on :5173
	cd $(FRONTEND) && npm run dev

# ─── Docker ───────────────────────────────────────────────────────────────────
docker-build: ## Build the production image
	docker compose build app

docker-up: ## Start the stack and print where things are
	@docker compose up --build -d
	@printf '\n  Application   http://localhost:8000\n'
	@printf '  Health        http://localhost:8000/health\n'
	@printf '  API docs      http://localhost:8000/docs\n'
	@printf '\n  The frontend is served by the same container on :8000.\n'
	@printf '  For hot-reload frontend work run: make frontend-run  (Vite, :5173)\n\n'

docker-down: ## Stop the stack and delete volumes, including biometric temp files
	docker compose --profile db down -v --remove-orphans

docker-logs: ## Tail application logs
	docker compose logs -f app

# ─── Housekeeping ─────────────────────────────────────────────────────────────
clean: ## Remove build output and caches (never .env or temp artefacts silently)
	rm -rf $(FRONTEND)/dist $(FRONTEND)/coverage $(FRONTEND)/node_modules/.vite
	rm -rf $(BACKEND)/var/tmp/*
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf $(BACKEND)/.pytest_cache $(BACKEND)/.mypy_cache $(BACKEND)/.ruff_cache