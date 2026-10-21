# Thin wrapper around dev.sh — the launcher itself lives there.
SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help dev install test clean

help: ## show available targets
	@grep -E '^[a-z]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-8s\033[0m %s\n", $$1, $$2}'

dev: ## start the backend and frontend together (Ctrl+C stops both)
	@./dev.sh

install: ## install backend and frontend dependencies
	cd backend && uv sync --dev
	cd frontend && pnpm install --frozen-lockfile

test: ## run the backend test suite against the mock engine
	cd backend && uv run pytest -q

clean: ## remove launcher logs and build output
	rm -rf .dev-logs frontend/.next
