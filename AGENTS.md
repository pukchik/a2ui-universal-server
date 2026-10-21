# Работа с проектом

README сохраняет порядок «идея и сценарии → текущая реализация → запуск». Команды разработки и проверки находятся в `package.json`; подробности CI — в [docs/CI.md](docs/CI.md).

При изменении CI сохраняйте отдельную job `tests` с настоящей PostgreSQL и зависимую `build`, собирающую точный проверенный SHA. Полный тестовый прогон требует `TEST_DATABASE_URL`; без него часть Vitest пропускается. Для изолированного кластера доступен `pnpm test:ci`.

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

Only trusted code may execute on the host-network runner. The demo deployment
uses only the fixture adapter and a disposable database; see docs/DEMO.md. Persistent
Codex/OIDC deployments require separately configured infrastructure and runtime credentials.
