# Собственный компонент StatusBadge

Пример соединяет три части: [catalog.json](catalog.json) — JSON Schema для агента/AJV, [model.ts](model.ts) — серверную SDK-модель с Zod и [renderer.ts](renderer.ts) — реализацию Lit. Идентификатор каталога у них совпадает. URL с `example.invalid` служит идентификатором; скачивать по нему ничего не требуется.

## Подключение к серверу

[server.ts](server.ts) собирает `statusProfile` через публичный `createCatalogProfile(document, modelCatalog)`. В своей точке входа передайте его вместе с адаптером:

```ts
import { startServer, configFrom } from "../../server/index.ts";
import { statusProfile } from "./server.ts";
import {
  codexAdapter,
  codexOptionsFrom,
} from "../../server/adapters/codex/index.ts";

const server = await startServer(configFrom(process.env), {
  adapter: codexAdapter(codexOptionsFrom(process.env)),
  catalogs: [statusProfile],
  instructions: "Покажи статус через StatusBadge из каталога в контексте.",
});
```

Пути предполагают файл в этой папке. Это фрагмент сборки приложения, не отдельная команда запуска примера; нужен env своей БД, авторизация и профиль Codex, как в [INTEGRATION.md](../../docs/INTEGRATION.md). Каталог по умолчанию — первый в `options.catalogs`, без массива используется встроенный Basic. Повтор одной пары `catalogId/profile` запрещён.

Для старого несовместимого типа SDK зарегистрируйте прежний профиль вторым элементом и оставьте соответствующий renderer в клиенте. Сервер выбирает модель по ID/профилю сохранённого снимка, а JSON Schema — из самого снимка. При несовместимом изменении модели меняйте `profile`, при изменении документа — `version`. Для нескольких версий одного ID renderer должен сам выбирать совместимую реализацию по метаданным снимка. Незарегистрированный сохранённый профиль не принимается при завершении нового запуска; прежний UI остаётся сохранённым.

`CATALOG_SOURCE_CONFIG` может загрузить local/HTTPS/MCP-документ с зарегистрированным ID/профилем. Сервер проверяет его по зарегистрированной модели. Без регистрации сохраняется строгая проверка ID/digest встроенного профиля. Загрузка JSON не устанавливает исполняемый код компонента.

## Проверка renderer без модели

Из корня checkout:

```sh
pnpm exec vite --host 127.0.0.1 --port 3119
```

Откройте `http://localhost:3119/examples/custom-catalog/preview.html`: появится «Собственный компонент работает». Preview подаёт статический A2UI в официальный MessageProcessor с `rendererCatalog`; сервер, PostgreSQL и Codex не запускаются. Для своего клиента подключите тот же каталог в MessageProcessor и рисуйте `a2ui-surface`, как в [preview.ts](preview.ts). Это минимальный технический пример без чата и действий формы.

## Границы профиля

Собственные типы проходят тот же A2UI `v0.9.1`, JSON Schema, SDK strict validation, ограничения размера, графа и опасных выражений. Каждый компонент содержит `id` и `component`; схема SDK описывает свойства без этих полей. Дочерние связи — статические `child`/`children`, корень поверхности — `root`. Функции каталога, шаблонные дети и `validationRegexp` пока отключены. Дополнительные разрешения собственного renderer, например внешние URL, проверяет разработчик приложения.

`tests/profiles.test.ts` проверяет положительный/ошибочный UI, несовместимые модели, локальный источник и закреплённый профиль в PostgreSQL. Проверка браузера описана в [VALIDATION.md](../../docs/VALIDATION.md). Для новых компонентов добавляйте собственные допустимые/ошибочные примеры и проверяйте сохранённые диалоги после обновления клиента.
