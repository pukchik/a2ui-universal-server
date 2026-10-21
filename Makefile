.DEFAULT_GOAL := help
.NOTPARALLEL:
.PHONY: help setup db build run codex start demo dev web check test smoke-codex

help: ## Показать команды
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Установить зависимости и создать .env, если его нет
	pnpm install --frozen-lockfile
	@test -e .env || cp .env.example .env
	@echo 'Укажите DATABASE_URL и CODEX_PROFILE_DIR в .env. Затем make db и make run.'

db: ## Запустить PostgreSQL из compose (внешнюю БД запускайте самостоятельно)
	docker compose up -d --wait db

build: ## Проверить типы и собрать клиент
	pnpm build

run: codex ## Запустить локальный сервер с Codex, без OIDC

codex: build ## Собрать клиент и запустить Codex на loopback
	AUTH_MODE=demo ADAPTER=codex HOST=127.0.0.1 pnpm start

start: build ## Запустить сервер с авторизацией и адаптером из .env
	pnpm start

demo: build ## Локальная демка с тестовым адаптером, без вызовов модели
	AUTH_MODE=demo ADAPTER=fixture HOST=127.0.0.1 pnpm start

dev: ## Сервер с перезапуском; настройки берутся из .env
	pnpm dev

web: ## Vite для разработки клиента (PUBLIC_URL=http://localhost:5173)
	pnpm web:dev

check: ## Форматирование и типы
	pnpm format:check
	pnpm check

test: ## Тесты; для полного прогона задайте TEST_DATABASE_URL
	pnpm test

smoke-codex: ## Настоящий запрос к Codex и действие A2UI; нужна отдельная БД
	pnpm smoke:codex
