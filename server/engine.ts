import { randomBytes, createHash } from "node:crypto";
import { Store } from "./storage/store.ts";
import type { ToolRegistry } from "./tools.ts";
import { runAdapter } from "./adapters/types.ts";
import type { CatalogSnapshot } from "../packages/catalogs/src/index.ts";
import type { Adapter, AgentContext } from "./adapters/types.ts";
import type { Json, Run } from "../packages/contracts/src/index.ts";
import { AppError } from "../packages/core/src/errors.ts";
import { safeJson } from "../packages/core/src/ui.ts";
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export class Engine {
  catalog?: CatalogSnapshot;
  instructions = "";
  store: Store;
  adapter: Adapter;
  url: string;
  concurrency: number;
  timeoutMs: number;
  readonly tools: ToolRegistry;
  active = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  tokens = new Map<string, { run: Run; expires: number }>();
  timer?: ReturnType<typeof setInterval>;
  pumping = false;
  stopping = false;
  constructor(
    store: Store,
    adapter: Adapter,
    url: string,
    concurrency = 2,
    timeoutMs = 120000,
    tools: ToolRegistry = {},
  ) {
    this.store = store;
    this.adapter = adapter;
    this.url = url;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.tools = tools;
  }
  start() {
    this.timer = setInterval(() => {
      void this.pump().catch((e) =>
        console.error("scheduler:", e instanceof Error ? e.message : "error"),
      );
    }, 200);
    this.timer.unref();
  }
  async pump() {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.concurrency && !this.stopping) {
        const run = await this.store.claim();
        if (!run) break;
        if (this.stopping) {
          await this.store.fail(run, "interrupted", "Сервер останавливается");
          break;
        }
        const controller = new AbortController();
        const task = Promise.resolve()
          .then(() => this.execute(run, controller))
          .finally(() => {
            this.revoke(run.id);
            this.active.delete(run.id);
          });
        this.active.set(run.id, { controller, task });
      }
    } finally {
      this.pumping = false;
    }
  }
  revoke(id: string) {
    for (const [key, value] of this.tokens)
      if (value.run.id === id) this.tokens.delete(key);
  }
  cancel(id: string) {
    this.revoke(id);
    this.active.get(id)?.controller.abort(new AppError(409, "cancelled"));
  }
  authorize(token: string): Run {
    const entry = this.tokens.get(digest(token));
    if (!entry || entry.expires < Date.now())
      throw new AppError(401, "invalid_run_token");
    return entry.run;
  }
  async callTool(run: Run, name: string, args: unknown, id: string) {
    safeJson(args);
    const tool = Object.hasOwn(this.tools, name) ? this.tools[name] : undefined;
    if (!tool) throw new AppError(403, "tool_denied");
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw new AppError(422, "tool_arguments");
    if (JSON.stringify(args).length > 16000)
      throw new AppError(422, "tool_size");
    const start = await this.store.toolStart(run, id, name, args);
    if (start.cached) return start.result;
    try {
      const result = (await tool.execute(parsed.data as never)) as Json;
      await this.store.toolEnd(run, id, result);
      return result;
    } catch (e) {
      await this.store.toolEnd(
        run,
        id,
        { error: "Источник не вернул результат" },
        true,
      );
      throw e;
    }
  }
  private async execute(run: Run, controller: AbortController) {
    const timer = setTimeout(
      () =>
        controller.abort(
          new AppError(504, "run_timeout", "Превышено время выполнения."),
        ),
      this.timeoutMs,
    );
    try {
      const { rows } = await this.store.pool.query(
        "SELECT user_id FROM dialogs WHERE id=$1",
        [run.dialogId],
      );
      const snapshot = await this.store.snapshot(run.dialogId, rows[0].user_id);
      if (
        JSON.stringify(snapshot).length +
          JSON.stringify(this.catalog ?? {}).length >
        128000
      )
        throw new AppError(
          422,
          "context_limit",
          "Контекст слишком большой. Начните новый диалог.",
        );
      const token = randomBytes(32).toString("base64url");
      this.tokens.set(digest(token), {
        run,
        expires: Date.now() + this.timeoutMs,
      });
      const context: AgentContext = {
        run,
        dialog: snapshot.dialog,
        taskState: snapshot.dialog.taskState ?? {},
        history: snapshot.messages,
        catalog: snapshot.dialog.catalog ?? this.catalog,
        instructions: this.instructions,
        toolUrl: this.url,
        token,
      };
      const results: unknown[] = [];
      const call = async (name: string, args: unknown, id: string) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = await this.callTool(run, name, args, id);
        results.push({ name, args, result });
        return result;
      };
      const output = await runAdapter(
        this.adapter,
        context,
        call,
        controller.signal,
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        await this.store.complete(
          run,
          output.text,
          JSON.parse(output.a2uiJson),
        );
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof AppError && error.status === 422)
        )
          throw error;
        this.revoke(run.id);
        if (controller.signal.aborted) throw controller.signal.reason;
        const calls = await this.store.pool.query(
          "SELECT name,args,result FROM tool_calls WHERE run_id=$1 AND status='succeeded'",
          [run.id],
        );
        const repaired = await runAdapter(
          this.adapter,
          {
            ...context,
            token: "",
            repair: {
              output: JSON.stringify(output),
              error: error instanceof Error ? error.message : "invalid_ui",
              results: calls.rows,
            },
          },
          () => Promise.reject(new AppError(403, "repair_tools_disabled")),
          controller.signal,
        );
        if (controller.signal.aborted) throw controller.signal.reason;
        await this.store.complete(
          run,
          repaired.text,
          JSON.parse(repaired.a2uiJson),
        );
      }
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof SyntaxError
            ? "invalid_ui"
            : "agent_failed";
      const message =
        error instanceof AppError
          ? error.message
          : "Не удалось завершить запрос агента.";
      await this.store.fail(run, code, message);
    } finally {
      clearTimeout(timer);
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.pumping)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (const [id] of this.active) this.cancel(id);
    await Promise.allSettled([...this.active.values()].map((v) => v.task));
  }
}
