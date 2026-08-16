.PHONY: help setup dev backend customer dashboard migrate seed test frontend-test lint typecheck check e2e-install e2e-list e2e-check e2e

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup:  ## Install backend, frontend, and root dependencies
	cd backend && uv sync
	cd customer-app && npm install
	cd internal-dashboard && npm install
	npm install
	@echo "Now: npx supabase link --project-ref YOUR_REF && make migrate"

migrate:  ## Push migrations to Supabase
	npx supabase db push

seed:  ## Seed the optional 61-dish curated starter set
	uv run --project backend python seeds/seed_dishes.py

dev:  ## Run backend + both apps
	@echo "backend :8000 · customer :3000 · dashboard :3001"
	@trap 'kill 0' EXIT; \
	(cd backend && uv run uvicorn app.main:app --reload --port 8000) & \
	(cd customer-app && npm run dev) & \
	(cd internal-dashboard && npm run dev) & \
	wait

backend:  ## Backend only
	cd backend && uv run uvicorn app.main:app --reload --port 8000

test:  ## Run the test suite
	cd backend && uv run pytest -q

frontend-test:  ## Run both frontend unit suites
	cd customer-app && npm run test
	cd internal-dashboard && npm run test

lint:  ## Lint and format-check backend code
	cd backend && uv run ruff check app tests && uv run ruff format --check app tests

typecheck:  ## Type-check strict backend boundaries and both frontends
	cd backend && uv run mypy app/core app/domain/admin app/domain/water app/services/db_results.py app/services/identity.py
	cd customer-app && npm run typecheck
	cd internal-dashboard && npm run typecheck

check: lint typecheck test frontend-test  ## Local CI parity checks
	cd backend && uv run lint-imports
	@bash scripts/check-frontend-isolation.sh

e2e-install:  ## Install the root E2E package and Playwright Chromium
	npm install
	npm run e2e:install

e2e-list:  ## Statically discover hosted E2E scenarios (no secrets/services needed)
	npm run e2e:list

e2e-check:  ## Test the report code and statically discover browser scenarios
	npm run e2e:check

e2e:  ## Run real hosted E2E and always generate an evidence PDF
	npm run e2e
