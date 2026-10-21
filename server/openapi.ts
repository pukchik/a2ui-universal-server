import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifySchema } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  createDialogSchema,
  messageSchema,
  actionSchema,
  cancelSchema,
} from "../packages/contracts/src/index.ts";

const uuid = Type.String({ format: "uuid" });
const jsonObject = Type.Record(Type.String(), Type.Unknown());
const status = Type.Union(
  ["queued", "running", "succeeded", "failed", "cancelled"].map((value) =>
    Type.Literal(value),
  ),
);
const error = Type.Object({ code: Type.String(), message: Type.String() });
const action = actionSchema.properties.action;
const run = Type.Object(
  {
    id: uuid,
    dialogId: uuid,
    status,
    generation: uuid,
    input: Type.Object({
      text: Type.Optional(Type.String()),
      action: Type.Optional(action),
    }),
    error: Type.Optional(error),
  },
  { $id: "Run" },
);
const catalog = Type.Object(
  {
    id: Type.String(),
    protocol: Type.Literal("v0.9.1"),
    version: Type.String(),
    digest: Type.String(),
    profile: Type.String(),
    document: jsonObject,
    common: jsonObject,
  },
  { $id: "CatalogSnapshot" },
);
const ui = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    messages: Type.Array(
      Type.Object(
        { version: Type.Literal("v0.9.1") },
        { additionalProperties: true },
      ),
    ),
  },
  {
    $id: "UiState",
    description:
      "Полный принятый A2UI. Содержимое сообщений определяется закреплённым каталогом, а не OpenAPI.",
  },
);
const dialog = Type.Object(
  {
    id: uuid,
    userId: Type.String(),
    title: Type.String(),
    seq: Type.Integer(),
    mode: Type.Optional(
      Type.Union([Type.Literal("dialog"), Type.Literal("generation")]),
    ),
    taskState: Type.Optional(jsonObject),
    catalog: Type.Optional(Type.Ref(catalog)),
    ui: Type.Ref(ui),
    // OpenAPI 3.0 uses nullable, not JSON Schema's type: "null".
    run: Type.Object(run.properties, { nullable: true }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { $id: "Dialog" },
);
const chatMessage = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String(),
    runId: uuid,
    incomplete: Type.Optional(Type.Boolean()),
  },
  { $id: "ChatMessage" },
);
const snapshot = Type.Object(
  {
    dialog: Type.Ref(dialog),
    messages: Type.Array(Type.Ref(chatMessage)),
    throughSeq: Type.Integer({ minimum: 0 }),
    protocol: Type.Literal("v0.9.1"),
    catalogId: Type.String(),
    profile: Type.String(),
  },
  { $id: "Snapshot" },
);
const apiError = Type.Object({ error }, { $id: "ApiError" });
const event = Type.Object(
  {
    dialogId: uuid,
    seq: Type.Integer({ minimum: 1 }),
    type: Type.String(),
    runId: Type.Optional(uuid),
    payload: Type.Unknown(),
    createdAt: Type.String({ format: "date-time" }),
  },
  {
    $id: "DialogEvent",
    description:
      "JSON в SSE data:. id: содержит seq; это схема полезной нагрузки, не JSON HTTP-ответ.",
  },
);
const models = [
  run,
  catalog,
  ui,
  dialog,
  chatMessage,
  snapshot,
  apiError,
  event,
];
const params = Type.Object({ id: uuid });
const sessionSecurity = [{ sessionCookie: [] }];
const commandSecurity = [{ sessionCookie: [], csrfToken: [] }];
const errorDescriptions: Record<number, string> = {
  400: "Некорректные параметры или тело запроса",
  401: "Требуется действующая сессия",
  403: "Не совпадают Origin или CSRF-токен",
  404: "Ресурс отсутствует, недоступен пользователю или режим выключен",
  409: "Конфликт commandId, занятого диалога или версии UI",
  410: "Результат команды удалён по сроку хранения (command_expired)",
  422: "Недопустимое действие, курсор или пустое сообщение",
  429: "Превышена пользовательская или общая квота очереди",
  500: "Внутренняя ошибка сервера",
  501: "Обработчик custom-авторизации не предоставлен приложением",
};
function errors(...codes: number[]) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      { ...Type.Ref(apiError), description: errorDescriptions[code] },
    ]),
  );
}
const readErrors = errors(400, 401, 404, 500);
const commandErrors = errors(400, 401, 403, 404, 409, 410, 422, 429, 500);
const accepted = Type.Object(
  { commandId: uuid, dialogId: uuid, runId: uuid },
  {
    description:
      "Команда принята; результат выполнения читается из снимка или SSE",
  },
);
const cancelled = Type.Object({ commandId: uuid, runId: uuid, status });
const ok = Type.Object({ ok: Type.Literal(true) });

function doc(
  tag: string,
  operationId: string,
  summary: string,
  description: string,
  schema: FastifySchema,
): FastifySchema {
  return {
    tags: [tag],
    operationId,
    summary,
    description,
    security: sessionSecurity,
    ...schema,
  };
}

// These schemas are attached to the routes: Fastify validates/serializes them,
// and Swagger derives the document from the same registered routes.
export const api = {
  health: doc(
    "service",
    "health",
    "Проверить доступность процесса",
    "Liveness без проверки PostgreSQL или модели.",
    {
      security: [],
      response: {
        200: Type.Object({ ok: Type.Literal(true), version: Type.String() }),
        ...errors(500),
      },
    },
  ),
  config: doc(
    "service",
    "getConfig",
    "Получить конфигурацию протокола",
    "Текущий каталог новых диалогов и метка адаптера. Старые диалоги используют собственный закреплённый снимок.",
    {
      security: [],
      response: {
        200: Type.Object({
          protocol: Type.Literal("v0.9.1"),
          catalogId: Type.String(),
          profile: Type.String(),
          adapter: Type.String(),
        }),
        ...errors(500),
      },
    },
  ),
  session: doc(
    "auth",
    "getSession",
    "Получить текущую сессию и CSRF-токен",
    "Публичная проверка сессии. Без входа возвращает authenticated=false; CSRF выдаётся только вошедшему пользователю.",
    {
      security: [],
      response: {
        200: Type.Object({
          authenticated: Type.Boolean(),
          authMode: Type.Union(
            ["oidc", "demo", "custom"].map((value) => Type.Literal(value)),
          ),
          adapter: Type.String(),
          userId: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          csrf: Type.Optional(Type.String()),
        }),
        ...errors(500),
      },
    },
  ),
  demoLogin: doc(
    "auth",
    "demoLogin",
    "Войти в локальную демку",
    "Доступно только при AUTH_MODE=demo на loopback. Нужен Origin этого сервера; браузер выставляет его автоматически.",
    {
      security: [],
      response: { 200: ok, ...errors(403, 404, 500) },
    },
  ),
  login: doc(
    "auth",
    "login",
    "Начать вход",
    "OIDC перенаправляет к провайдеру. Custom-режим вызывает обработчик приложения с его собственными параметрами и ответом. Для входа открывайте этот URL в отдельной вкладке браузера.",
    {
      security: [],
      response: {
        200: Type.Unknown({
          description: "Ответ custom login handler приложения",
        }),
        302: Type.String({
          description: "Перенаправление к провайдеру или приложению",
          headers: { location: { type: "string" } },
        }),
        ...errors(500, 501),
      },
    },
  ),
  callback: doc(
    "auth",
    "oidcCallback",
    "Обработать OIDC callback",
    "Служебный обратный маршрут провайдера с code/state и cookie a2ui_oidc. Вручную вызывать не требуется.",
    {
      security: [],
      querystring: Type.Object(
        {
          code: Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
      response: {
        302: Type.String({
          description: "Вход завершён; переход в приложение",
          headers: { location: { type: "string" } },
        }),
        ...errors(400, 401, 404, 500),
      },
    },
  ),
  logout: doc(
    "auth",
    "logout",
    "Завершить сессию",
    "Отзывает встроенную сессию либо вызывает custom logout. Нужны cookie, X-CSRF-Token из /v1/session и совпадающий Origin.",
    {
      security: commandSecurity,
      response: { 200: ok, ...errors(401, 403, 500, 501) },
    },
  ),
  listDialogs: doc(
    "dialogs",
    "listDialogs",
    "Получить свои диалоги",
    "Последние 100 диалогов по времени создания; одноразовые генерации исключены. Пагинации пока нет.",
    {
      response: {
        200: Type.Array(
          Type.Object({
            id: uuid,
            title: Type.String(),
            createdAt: Type.String({ format: "date-time" }),
          }),
        ),
        ...errors(401, 500),
      },
    },
  ),
  createDialog: doc(
    "dialogs",
    "createDialog",
    "Создать диалог",
    "commandId — UUID операции. Точный повтор возвращает прежний результат; другое тело с тем же UUID даёт 409. Для POST нужны CSRF и Origin.",
    {
      security: commandSecurity,
      body: createDialogSchema,
      response: {
        201: Type.Object({ commandId: uuid, dialogId: uuid }),
        ...errors(400, 401, 403, 409, 410, 500),
      },
    },
  ),
  getDialog: doc(
    "dialogs",
    "getDialog",
    "Получить состояние диалога",
    "Возвращает UI, каталог и последний запуск только владельцу. Для согласованной истории и курсора используйте snapshot.",
    {
      params,
      response: { 200: Type.Ref(dialog), ...readErrors },
    },
  ),
  snapshot: doc(
    "dialogs",
    "getSnapshot",
    "Получить согласованный снимок",
    "Полный UI, история и throughSeq прочитаны согласованно. Замените состояние renderer и читайте SSE после throughSeq.",
    {
      params,
      response: { 200: Type.Ref(snapshot), ...readErrors },
    },
  ),
  messages: doc(
    "dialogs",
    "listMessages",
    "Получить историю сообщений",
    "Текстовые сообщения пользователя и ассистента. A2UI находится отдельно в dialog.ui, а не в этой истории.",
    {
      params,
      response: { 200: Type.Array(Type.Ref(chatMessage)), ...readErrors },
    },
  ),
  message: doc(
    "dialogs",
    "sendMessage",
    "Отправить сообщение агенту",
    "202 означает постановку в очередь, не успешный результат агента. Для сетевого повтора сохраните commandId. Нужны CSRF и Origin.",
    {
      security: commandSecurity,
      params,
      body: messageSchema,
      response: { 202: accepted, ...commandErrors },
    },
  ),
  action: doc(
    "dialogs",
    "sendAction",
    "Передать действие интерфейса",
    "Сервер сверяет uiRevision, поверхность, компонент, имя и контекст с сохранённым UI. Форма должна относиться к последнему успешному запуску. Нужны CSRF и Origin.",
    {
      security: commandSecurity,
      params,
      body: actionSchema,
      response: { 202: accepted, ...commandErrors },
    },
  ),
  cancel: doc(
    "dialogs",
    "cancelRun",
    "Отменить запуск диалога",
    "Отмена идемпотентна; завершённый запуск сохраняет свой статус. Нужны CSRF и Origin.",
    {
      security: commandSecurity,
      params: Type.Object({ id: uuid, runId: uuid }),
      body: cancelSchema,
      response: {
        200: cancelled,
        ...errors(400, 401, 403, 404, 409, 410, 500),
      },
    },
  ),
  events: doc(
    "dialogs",
    "watchEvents",
    "Подписаться на события диалога (SSE)",
    "Длительное соединение text/event-stream. id: — seq, data: — JSON DialogEvent; именованных event: нет. Last-Event-ID приоритетнее after. ui.updated содержит полный UI. При разрыве последовательности перечитайте snapshot. Heartbeat — комментарий. Swagger не заменяет EventSource и может ожидать завершения потока.",
    {
      params,
      querystring: Type.Object({
        after: Type.Optional(
          Type.String({
            description: "seq последнего применённого события, по умолчанию 0",
          }),
        ),
      }),
      headers: Type.Object(
        {
          "last-event-id": Type.Optional(
            Type.String({ description: "seq; имеет приоритет над after" }),
          ),
        },
        { additionalProperties: true },
      ),
      response: {
        200: {
          description: "Поток событий; формат data описан моделью DialogEvent",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                example:
                  'id: 1\ndata: {"dialogId":"00000000-0000-4000-8000-000000000001","seq":1,"type":"run.queued","payload":{},"createdAt":"2026-10-21T00:00:00Z"}\n\n',
              },
            },
          },
        },
        ...readErrors,
        ...errors(422),
      },
    },
  ),
  generate: doc(
    "generations",
    "generate",
    "Создать разовую генерацию",
    "Отдельное сохранённое задание без продолжения другого диалога. Проверяйте статус через GET generation. Применяются те же CSRF, Origin, commandId и квоты.",
    {
      security: commandSecurity,
      body: messageSchema,
      response: {
        202: Type.Object({ commandId: uuid, generationId: uuid, runId: uuid }),
        ...commandErrors,
      },
    },
  ),
  generation: doc(
    "generations",
    "getGeneration",
    "Получить результат генерации",
    "Снимок задания владельца. Опрос до succeeded, failed или cancelled; отдельного SSE для генераций нет.",
    {
      params,
      response: { 200: Type.Ref(snapshot), ...readErrors },
    },
  ),
  cancelGeneration: doc(
    "generations",
    "cancelGeneration",
    "Отменить разовую генерацию",
    "Отменяет текущий запуск генерации. Нужны CSRF и Origin.",
    {
      security: commandSecurity,
      params,
      body: cancelSchema,
      response: {
        200: cancelled,
        ...errors(400, 401, 403, 404, 409, 410, 500),
      },
    },
  ),
};

// Self-contained: Swagger serializes this function into its browser bundle.
export async function swaggerRequest(request: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  credentials?: string;
}) {
  const target = new URL(
    request.url ?? window.location.href,
    window.location.href,
  );
  if (target.origin !== window.location.origin) return request;
  request.credentials = "same-origin";
  if (
    !["GET", "HEAD", "OPTIONS"].includes(
      (request.method ?? "GET").toUpperCase(),
    )
  ) {
    const response = await fetch("/v1/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Не удалось проверить сессию");
    const session = await response.json();
    if (session.authenticated && session.csrf) {
      request.headers ??= {};
      request.headers["X-CSRF-Token"] = session.csrf;
    }
  }
  return request;
}

export async function registerOpenApi(app: FastifyInstance) {
  for (const schema of models) app.addSchema(schema);
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "A2UI Uniserver",
        version: "0.1.0",
        description:
          "API диалогов, A2UI и заданий агента. Вход: /auth/login (OIDC/custom) или POST /auth/demo (локально). Cookie передаётся браузером; перед POST нужен X-CSRF-Token из /v1/session и Origin этого сервера. В Swagger CSRF добавляется автоматически. Для новой операции создавайте новый UUID commandId, для повтора сохраняйте прежний. Служебный MCP документируется отдельно в docs/API.md.",
      },
      servers: [
        { url: "/", description: "Тот же origin, что у страницы документации" },
      ],
      tags: [
        { name: "service", description: "Доступность и конфигурация" },
        { name: "auth", description: "Вход и сессии" },
        { name: "dialogs", description: "Диалоги, A2UI, действия и SSE" },
        { name: "generations", description: "Разовые задания" },
      ],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "a2ui_session",
            description:
              "HttpOnly cookie OIDC/demo. В custom-режиме имя cookie задаёт приложение. Вход выполняйте через браузер; вручную Cookie через Authorize установить нельзя.",
          },
          csrfToken: {
            type: "apiKey",
            in: "header",
            name: "X-CSRF-Token",
            description:
              "Токен текущей сессии из GET /v1/session; Swagger добавляет автоматически.",
          },
        },
      },
    },
    refResolver: {
      buildLocalReference: (schema, _base, _fragment, index) =>
        String(schema.$id ?? `schema${index}`),
    },
    transform: ({ schema, url }) => ({
      schema: { ...schema, hide: schema?.hide ?? !schema?.operationId },
      url,
    }),
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    staticCSP: true,
    // Exact inline-style hash reported by Chromium for pinned Swagger UI 6.1.2.
    transformStaticCSP: (header) =>
      header.replace(
        "style-src 'self'",
        "style-src 'self' 'sha256-RL3ie0nH+Lzz2YNqQN83mnU0J1ot4QL7b99vMdIX99w='",
      ),
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      validatorUrl: null,
      requestInterceptor: swaggerRequest,
    },
  });
}
