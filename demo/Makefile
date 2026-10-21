ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

.DEFAULT_GOAL := help
.NOTPARALLEL:
.PHONY: help setup db build run codex start demo dev web check test smoke-codex

help: ## Показать команды
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Установить зависимости и создать .env, если его нет
	cd "$(ROOT)" && pnpm install --frozen-lockfile
	@test -e "$(ROOT)/demo/.env" || cp "$(ROOT)/demo/.env.example" "$(ROOT)/demo/.env"
	@echo 'Укажите DATABASE_URL и CODEX_PROFILE_DIR в demo/.env. Затем make db и make run.'

db: ## Запустить PostgreSQL из compose (внешнюю БД запускайте самостоятельно)
	cd "$(ROOT)" && docker compose --env-file demo/.env -f demo/compose.yaml up -d --wait db

build: ## Проверить типы и собрать клиент
	cd "$(ROOT)" && pnpm build

run: codex ## Запустить локальный сервер с Codex, без OIDC

codex: build ## Собрать клиент и запустить Codex на loopback
	cd "$(ROOT)" && AUTH_MODE=demo ADAPTER=codex HOST=127.0.0.1 pnpm start

start: build ## Запустить сервер с авторизацией и адаптером из demo/.env
	cd "$(ROOT)" && pnpm start

demo: build ## Локальная демка с тестовым адаптером, без вызовов модели
	cd "$(ROOT)" && AUTH_MODE=demo ADAPTER=fixture HOST=127.0.0.1 pnpm start

dev: ## Сервер с перезапуском; настройки берутся из demo/.env
	cd "$(ROOT)" && pnpm dev

web: ## Vite для разработки клиента (PUBLIC_URL=http://localhost:5173)
	cd "$(ROOT)" && pnpm web:dev

check: ## Форматирование и типы
	cd "$(ROOT)" && pnpm format:check
	cd "$(ROOT)" && pnpm check

test: ## Тесты; для полного прогона задайте TEST_DATABASE_URL
	cd "$(ROOT)" && pnpm test

smoke-codex: ## Настоящий запрос к Codex и действие A2UI; нужна отдельная БД
	cd "$(ROOT)" && pnpm smoke:codex
