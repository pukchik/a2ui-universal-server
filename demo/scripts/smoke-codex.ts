import { randomUUID } from "node:crypto";
import { buildDemoApp as buildApp } from "../server/app.ts";
import { configFrom } from "../../apps/server/src/config.ts";
import type { Action } from "../../packages/contracts/src/index.ts";
const config = configFrom({
  ...process.env,
  AUTH_MODE: "demo",
  ADAPTER: "codex",
  HOST: "127.0.0.1",
  PORT: process.env.PORT ?? "3110",
  PUBLIC_URL: `http://localhost:${process.env.PORT ?? "3110"}`,
});
const { app, store, engine } = await buildApp(config, {
  logger: false,
  startEngine: false,
});
try {
  await store.migrate();
  await store.acquireLock(() => {
    void engine.stop();
  });
  await app.listen({ host: config.HOST, port: config.PORT });
  engine.start();
  const result = (await store.create("codex-smoke", randomUUID())) as {
    dialogId: string;
  };
  await store.accept("codex-smoke", result.dialogId, randomUUID(), {
    text: "Покажи две компактные лампы с тёплым светом из демонстрационного каталога. Обязательно получи данные через search_products. Покажи карточки и кнопку «Подробнее» для каждой.",
  });
  let previous = "";
  const deadline = Date.now() + config.RUN_TIMEOUT_MS + 3000;
  while (Date.now() < deadline) {
    const snapshot = await store.snapshot(result.dialogId, "codex-smoke");
    const status = snapshot.dialog.run?.status ?? "none";
    if (status !== previous) {
      console.log("Codex smoke:", status);
      previous = status;
    }
    if (status === "failed" || status === "cancelled")
      throw new Error(
        JSON.stringify(snapshot.dialog.run?.error ?? { code: status }),
      );
    if (status === "succeeded") {
      const calls = await store.pool.query(
        "SELECT name,status FROM tool_calls WHERE run_id=$1",
        [snapshot.dialog.run!.id],
      );
      if (
        !calls.rows.some(
          (c) => c.name === "search_products" && c.status === "succeeded",
        )
      )
        throw new Error("Не было подтверждённого вызова MCP search_products");
      if (!snapshot.dialog.ui.messages.length) throw new Error("Пустой A2UI");
      console.log(
        JSON.stringify(
          {
            dialogId: result.dialogId,
            runId: snapshot.dialog.run!.id,
            messages: snapshot.dialog.ui.messages.length,
            toolCalls: calls.rows,
          },
          null,
          2,
        ),
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (previous !== "succeeded") throw new Error("Smoke deadline");
  const before = await store.snapshot(result.dialogId, "codex-smoke");
  let action: Action | undefined;
  for (const message of before.dialog.ui.messages) {
    const update = message.updateComponents as
      | {
          surfaceId: string;
          components: {
            id: string;
            component: string;
            action?: {
              event?: { name: string; context?: Record<string, unknown> };
            };
          }[];
        }
      | undefined;
    for (const component of update?.components ?? []) {
      const event = component.action?.event;
      if (
        component.component === "Button" &&
        typeof event?.context?.productId === "string"
      )
        action = {
          surfaceId: update!.surfaceId,
          componentId: component.id,
          name: event.name,
          context: { productId: event.context.productId },
        };
    }
  }
  if (!action) throw new Error("Нет кнопки Подробнее с неизменяемым productId");
  await store.accept(
    "codex-smoke",
    result.dialogId,
    randomUUID(),
    { action },
    before.dialog.ui.revision,
  );
  const actionDeadline = Date.now() + config.RUN_TIMEOUT_MS + 3000;
  let after: typeof before | undefined;
  while (Date.now() < actionDeadline) {
    after = await store.snapshot(result.dialogId, "codex-smoke");
    const status = after.dialog.run?.status;
    if (status === "failed" || status === "cancelled")
      throw new Error(
        JSON.stringify(after.dialog.run?.error ?? { code: status }),
      );
    if (status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (after?.dialog.run?.status !== "succeeded")
    throw new Error("Action smoke deadline");
  const calls = await store.pool.query(
    "SELECT name,status FROM tool_calls WHERE run_id=$1",
    [after.dialog.run.id],
  );
  if (
    !calls.rows.some(
      (call) => call.name === "get_product" && call.status === "succeeded",
    )
  )
    throw new Error("Действие не вызвало MCP get_product");
  if (
    after.dialog.ui.revision <= before.dialog.ui.revision ||
    after.dialog.catalog?.digest !== before.dialog.catalog?.digest
  )
    throw new Error("Неверное продолжение состояния UI/каталога");
  console.log(
    JSON.stringify(
      {
        action: action.name,
        status: "succeeded",
        revision: after.dialog.ui.revision,
        toolCalls: calls.rows,
      },
      null,
      2,
    ),
  );
} finally {
  await engine.stop();
  await app.close();
  await store.close();
}
