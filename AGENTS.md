# Инструкции агентам-разработчикам

Этот файл предназначен агенту, который меняет сервер или подключает его к другому проекту. Прикладной Codex, запускаемый сервером, получает промпт отдельно и работает с `--ignore-rules`: этот AGENTS.md не заменяет инструкции приложения.

## При подключении сервера

Сначала прочитайте [docs/INTEGRATION.md](docs/INTEGRATION.md): там есть полная точка входа, регистрация инструментов, подключение renderer и критерии сквозной проверки. При работе с HTTP, SSE, повтором команд или действиями формы дополнительно прочитайте [docs/API.md](docs/API.md).

- Подключение сейчас из исходников: сохраняйте вместе `server/`, `packages/`, `catalog/` и lockfile. Пакет private, готовой установки через npm и автозагрузки плагинов нет.
- Собственное приложение вызывает `startServer` из `server/index.ts` с адаптером, инструментами и инструкциями. Штатные `pnpm start` / `make run` запускают `demo/` с лампами.
- `startServer` выполняет миграции, lock, listener и Engine; `close()` идемпотентно закрывает ресурсы. Встраивание в другой процесс: `handleSignals: false` и его собственный вызов close. Низкоуровневый `buildApp` оставляет lifecycle вызывающему коду. Один исполнитель на БД.
- Cookie/CSRF и относительные URL требуют одного origin для клиента, `/auth` и `/v1`. Встроенный вход — OIDC; demo-вход только на loopback. Для существующей сессии проекта используйте `AUTH_MODE=custom` и `options.auth`, сохраняя CSRF/Origin и проверяя срок сессии.
- `ToolRegistry.execute(args, context)` получает readonly `userId`, `dialogId`, `runId`, `signal`; владелец берётся из БД активного запуска. Фильтруйте ресурсы по context.userId, передавайте signal в отменяемые операции и проверяйте чужой ID тестом. Аргумент userId от агента не подтверждает права. MCP пока объявляет инструменты читающими; подтверждения записей нет.
- Промпт приложения передавайте через `options.instructions` и/или `PROJECT_INSTRUCTIONS_FILE`. `server/prompt.ts` упаковывает контекст для Codex; `demo/server/instructions.ts` — только предметный пример. Credentials передавайте отдельно, вне промпта и Git.
- Пример собственной сессии и инструментов — [examples/notes](examples/notes/README.md); внешний процесс проверяет `tests/external-project.test.ts`. Критерий интеграции: запрос → инструмент → принятый UI → действие → обновление, затем восстановление, отмена, отказ чужому пользователю и корректная обработка ошибочного ответа. Границы прошлых прогонов — [docs/VALIDATION.md](docs/VALIDATION.md).

## При изменении этого checkout

- README сохраняет порядок «идея и сценарии → текущая реализация → запуск». Технические контракты держите в [STACK.md](STACK.md); пути и границы модулей — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Общее ядро `server/` не импортирует предметные файлы `demo/`. Файлы провайдера храните в собственной папке адаптера: сейчас `server/adapters/codex/`; общие типы остаются в `server/adapters/types.ts`.
- Общий `configFrom` проверяет только сервер: провайдерные настройки проверяет factory адаптера (`codexOptionsFrom`), выбор Codex/fixture находится в `demo/server/config.ts`. Для нового адаптера прочитайте его общие типы и раздел адаптеров в STACK. Модельный цикл ведёт сервер, цикл готового агента — агент. Результат: `{text,a2uiJson}`, где `a2uiJson` — строка JSON-массива A2UI. Соблюдайте AbortSignal и режим repair без инструментов; историю/UI сохраняет Engine через Store.
- Для изменения компонентов прочитайте [catalog/README.md](catalog/README.md). Обновляйте схемы, примеры и список согласованно; подтверждайте совместимость с SDK и renderer. Один JSON не реализует новый клиентский тип. Диалоги используют закреплённый документ каталога.
- Для изменения клиента прочитайте [demo/DESIGN.md](demo/DESIGN.md). Полный снимок заменяет состояние renderer; дубли/разрывы SSE не должны повторять ответы или UI.
- Команды определяются `package.json` и Makefile: `make check`, `make test-components`, `pnpm test`, `pnpm build`. Полный Vitest требует отдельной `TEST_DATABASE_URL`; без неё storage/HTTP пропускаются. Изолированный PostgreSQL запускает `pnpm test:ci` с подходящим `PG_BIN`.
- Настоящий Codex smoke запускайте только для проверки интеграции с доступной служебной авторизацией и отдельной БД: он расходует лимиты. Обычные тесты используют имитатор CLI. Форматирование/типы, HTTP, браузер, образ и реальный агент — разные уровни проверки; сообщайте, какие выполнены.
- При изменении CI прочитайте [docs/CI.md](docs/CI.md) и актуальные руководства ниже. Сохраняйте отдельную job `tests` с настоящей PostgreSQL и зависимую `build`, собирающую точный проверенный SHA. CD сейчас отключён.

## Strazh deployment rules

Before creating or changing `.gitea/workflows/*`, `strazh.deploy.json`, a deployment Dockerfile,
or deployment scripts targeting Strazh, read the CURRENT complete guide:

- URL: https://home.eralas.ru/deploy-docs/DEPLOYMENT.md
- From a Strazh CI job: http://127.0.0.1:8091/deploy-docs/DEPLOYMENT.md
- Via configured SSH connection to Strazh: /home/eralash/services/deploy/docs/DEPLOYMENT.md

If none is accessible, STOP deployment work and request access. Use the documented client
and the repository's project-scoped STRAZH_DEPLOY_TOKEN only for an authorized deployment.
Keep common Caddy/Compose/VPN protection unchanged. Read the current guide even if an older
copy is in context.

Before creating/updating CI workflows, also read the current portable CI/CD skill:
https://home.eralas.ru/deploy-docs/CICD_SKILL.md (inside a host-network job:
http://127.0.0.1:8091/deploy-docs/CICD_SKILL.md).
Assess repeated downloads/installations and supported dependency caches. Check live runner
cache support; preserve shared runner configuration and separate tests from dependent builds.
Verify cache misses and warm runs; report actual pipeline results separately from local checks.

Only trusted code may execute on the host-network runner. This repository currently enables
CI only; enabling CD requires the owner's configured infrastructure and runtime credentials.
