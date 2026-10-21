import Fastify from "fastify";
import swagger from "@fastify/swagger";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { Store } from "./storage/store.ts";
import { Engine } from "./engine.ts";
import { fixtureAdapter } from "./adapters/fixture.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { registerAuth } from "./auth.ts";
import { registerMcp } from "./mcp.ts";
import { configuredCatalog } from "./catalog-config.ts";
import { defaultCatalog } from "../../../packages/catalogs/src/index.ts";
import { AppError } from "../../../packages/core/src/errors.ts";
import {
  CATALOG_ID,
  PROFILE,
  createDialogSchema,
  messageSchema,
  actionSchema,
  cancelSchema,
} from "../../../packages/contracts/src/index.ts";
import type { Action } from "../../../packages/contracts/src/index.ts";
export async function buildApp(
  config: Config,
  options: { store?: Store; logger?: boolean; startEngine?: boolean } = {},
) {
  const streams = new Set<() => void>();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 160000,
    disableRequestLogging: true,
    loggerInstance: undefined,
  });
  const store = options.store ?? new Store(config.DATABASE_URL);
  store.catalog ??= config.CATALOG_SOURCE_CONFIG
    ? await configuredCatalog(config.CATALOG_SOURCE_CONFIG)
    : await defaultCatalog();
  const engine = new Engine(
    store,
    config.ADAPTER === "fixture"
      ? fixtureAdapter
      : codexAdapter({
          executable: config.CODEX_BIN,
          profileDir: config.CODEX_PROFILE_DIR!,
          model: config.CODEX_MODEL,
        }),
    new URL("/internal/mcp", `http://127.0.0.1:${config.PORT}`).href,
    config.MAX_CONCURRENT_RUNS,
    config.RUN_TIMEOUT_MS,
  );
  engine.catalog = store.catalog;
  if (config.PROJECT_INSTRUCTIONS_FILE) {
    const instructions = await readFile(
      config.PROJECT_INSTRUCTIONS_FILE,
      "utf8",
    );
    if (instructions.length > 16000)
      throw new Error("Инструкции проекта слишком большие");
    engine.instructions = instructions;
  }
  await app.register(swagger, {
    openapi: { info: { title: "A2UI Uniserver", version: "0.1.0" } },
  });
  app.get("/openapi.json", async () => app.swagger());
  await app.register(cookie);
  const auth = await registerAuth(app, store, config);
  app.addHook("onRequest", async (_req, reply) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "same-origin")
      .header("cache-control", "no-store");
  });
  app.setErrorHandler((error, req, reply) => {
    const httpError = error as { validation?: unknown; statusCode?: number };
    const code =
      error instanceof AppError
        ? error.code
        : httpError.validation
          ? "invalid_request"
          : "internal_error";
    const status =
      error instanceof AppError ? error.status : (httpError.statusCode ?? 500);
    if (status >= 500) req.log.error({ code }, "Request failed");
    reply.code(status).send({
      error: {
        code,
        message:
          error instanceof AppError
            ? error.message
            : status < 500
              ? "Проверьте запрос"
              : "Внутренняя ошибка сервера",
      },
    });
  });
  const params = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      runId: { type: "string", format: "uuid" },
    },
    required: ["id"],
  } as const;
  app.post<{ Body: { commandId: string; text: string } }>(
    "/v1/generations",
    { schema: { body: messageSchema } },
    async (req, reply) => {
      const user = await auth.requireUser(req);
      auth.csrf(req, user);
      const text = req.body.text.trim();
      if (!text) throw new AppError(422, "empty_message");
      return reply
        .code(202)
        .send(await store.generate(user.userId, req.body.commandId, text));
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/generations/:id",
    { schema: { params } },
    async (req) => {
      const result = await store.snapshot(
        req.params.id,
        (await auth.requireUser(req)).userId,
      );
      if (result.dialog.mode !== "generation")
        throw new AppError(404, "not_found");
      return {
        ...result,
        protocol: "v0.9.1",
        catalogId: result.dialog.catalog?.id ?? CATALOG_ID,
        profile: PROFILE,
      };
    },
  );
  app.post<{ Params: { id: string }; Body: { commandId: string } }>(
    "/v1/generations/:id/cancel",
    { schema: { params, body: cancelSchema } },
    async (req) => {
      const user = await auth.requireUser(req);
      auth.csrf(req, user);
      const dialog = await store.get(req.params.id, user.userId);
      if (dialog.mode !== "generation" || !dialog.run)
        throw new AppError(404, "not_found");
      const result = await store.cancel(
        user.userId,
        dialog.id,
        dialog.run.id,
        req.body.commandId,
      );
      if (result.status === "cancelled") engine.cancel(dialog.run.id);
      return result;
    },
  );
  app.get("/health", async () => ({ ok: true, version: "0.1.0" }));
  app.get("/v1/config", async () => ({
    protocol: "v0.9.1",
    catalogId: CATALOG_ID,
    profile: PROFILE,
    adapter: config.ADAPTER,
  }));
  app.get("/v1/dialogs", async (req) =>
    store.list((await auth.requireUser(req)).userId),
  );
  app.post<{ Body: { commandId: string } }>(
    "/v1/dialogs",
    { schema: { body: createDialogSchema } },
    async (req, reply) => {
      const user = await auth.requireUser(req);
      auth.csrf(req, user);
      return reply
        .code(201)
        .send(await store.create(user.userId, req.body.commandId));
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/dialogs/:id",
    { schema: { params } },
    async (req) =>
      store.get(req.params.id, (await auth.requireUser(req)).userId),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/dialogs/:id/snapshot",
    { schema: { params } },
    async (req) => ({
      ...(await store.snapshot(
        req.params.id,
        (await auth.requireUser(req)).userId,
      )),
      protocol: "v0.9.1",
      catalogId: CATALOG_ID,
      profile: PROFILE,
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/dialogs/:id/messages",
    { schema: { params } },
    async (req) =>
      (
        await store.snapshot(
          req.params.id,
          (await auth.requireUser(req)).userId,
        )
      ).messages,
  );
  app.post<{
    Params: { id: string };
    Body: { commandId: string; text: string };
  }>(
    "/v1/dialogs/:id/messages",
    { schema: { params, body: messageSchema } },
    async (req, reply) => {
      const user = await auth.requireUser(req);
      auth.csrf(req, user);
      const text = req.body.text.trim();
      if (!text) throw new AppError(422, "empty_message");
      return reply.code(202).send(
        await store.accept(user.userId, req.params.id, req.body.commandId, {
          text,
        }),
      );
    },
  );
  app.post<{
    Params: { id: string };
    Body: { commandId: string; uiRevision: number; action: Action };
  }>(
    "/v1/dialogs/:id/actions",
    { schema: { params, body: actionSchema } },
    async (req, reply) => {
      const user = await auth.requireUser(req);
      auth.csrf(req, user);
      return reply
        .code(202)
        .send(
          await store.accept(
            user.userId,
            req.params.id,
            req.body.commandId,
            { action: req.body.action },
            req.body.uiRevision,
          ),
        );
    },
  );
  app.post<{
    Params: { id: string; runId: string };
    Body: { commandId: string };
  }>(
    "/v1/dialogs/:id/runs/:runId/cancel",
    { schema: { params, body: cancelSchema } },
    async (req) => {
      const user = await auth.requireUser(req);
      auth.csrf(req, user);
      const result = await store.cancel(
        user.userId,
        req.params.id,
        req.params.runId,
        req.body.commandId,
      );
      if (result.status === "cancelled") engine.cancel(req.params.runId);
      return result;
    },
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/v1/dialogs/:id/events",
    { schema: { params } },
    async (req, reply) => {
      const session = await auth.requireUser(req);
      const cursor = req.headers["last-event-id"] ?? req.query.after ?? "0";
      if (
        typeof cursor !== "string" ||
        !/^\d+$/.test(cursor) ||
        !Number.isSafeInteger(Number(cursor))
      )
        throw new AppError(422, "invalid_cursor");
      let after = Number(cursor);
      await store.events(req.params.id, session.userId, after);
      let closed = false,
        busy = false;
      let timer: ReturnType<typeof setInterval>;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      const close = () => {
        if (closed) return;
        closed = true;
        streams.delete(close);
        clearInterval(timer);
        reply.raw.end();
      };
      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          if (!(await auth.read(req))) {
            close();
            return;
          }
          const events = await store.events(
            req.params.id,
            session.userId,
            after,
          );
          for (const event of events) {
            if (
              !reply.raw.write(
                `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
              )
            ) {
              close();
              return;
            }
            after = event.seq;
          }
          if (!events.length) reply.raw.write(": heartbeat\n\n");
        } catch {
          close();
        } finally {
          busy = false;
        }
      };
      streams.add(close);
      timer = setInterval(() => void tick(), 500);
      req.raw.on("close", close);
      reply.raw.on("close", close);
      void tick();
    },
  );
  registerMcp(app, engine);
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot });
  else
    app.get("/", async (_req, reply) =>
      reply
        .code(503)
        .type("text/plain")
        .send("Сначала соберите клиент: pnpm build"),
    );
  app.addHook("preClose", async () => {
    for (const close of streams) close();
    await engine.stop();
  });
  if (options.startEngine !== false) engine.start();
  return { app, store, engine };
}
