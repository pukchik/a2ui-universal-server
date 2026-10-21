import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../server/storage/store.ts";
import { Engine } from "../server/engine.ts";
import { configFrom, startServer } from "../server/index.ts";
import type { Adapter, AgentOutput, ToolContext } from "../server/index.ts";
import type { ToolCaller } from "../server/adapters/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = { text: "late answer must not appear", a2uiJson: "[]" };
const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("non-cooperative async adapters and tools", () => {
  const store = new Store(database!);
  const owner = `deadlines-${randomUUID()}`;
  beforeAll(() => store.migrate());
  afterAll(() => store.close());
  async function queued() {
    const { dialogId } = (await store.create(owner, randomUUID())) as {
      dialogId: string;
    };
    await store.accept(owner, dialogId, randomUUID(), { text: "wait" });
    return dialogId;
  }
  const terminal = (engine: Engine) =>
    expect
      .poll(() => engine.active.size, { timeout: 3000, interval: 10 })
      .toBe(0);

  it.each(["agent", "model"] as const)(
    "times out a hung %s, frees its slot and ignores late results",
    async (kind) => {
      const pending = deferred<AgentOutput>();
      const entered = deferred<void>();
      let call!: ToolCaller;
      let token = "";
      const adapter: Adapter =
        kind === "agent"
          ? {
              kind,
              async run(context, caller) {
                call = caller;
                token = context.token;
                entered.resolve();
                return pending.promise;
              },
            }
          : {
              kind,
              async step(context) {
                token = context.token;
                entered.resolve();
                return { type: "output", output: await pending.promise };
              },
            };
      const engine = new Engine(store, adapter, "http://127.0.0.1:1", 1, 150);
      const id = await queued();
      try {
        await engine.pump();
        await entered.promise;
        await terminal(engine);
        expect((await store.get(id, owner)).run).toMatchObject({
          status: "failed",
          error: { code: "run_timeout" },
        });
        expect(() => engine.authorize(token)).toThrow();
        if (kind === "agent")
          await expect(call("late", {}, "late")).rejects.toMatchObject({
            code: "run_timeout",
          });
        engine.adapter = {
          kind: "agent",
          async run() {
            return { text: "next", a2uiJson: "[]" };
          },
        };
        await store.accept(owner, id, randomUUID(), { text: "next" });
        await engine.pump();
        await terminal(engine);
        const before = await store.snapshot(id, owner);
        expect(before.dialog.run?.status).toBe("succeeded");
        pending.resolve(result);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await store.snapshot(id, owner)).toEqual(before);
      } finally {
        pending.resolve(result);
        await engine.stop();
      }
    },
  );

  it("times out a hung tool and never records its late result or rejection", async () => {
    const pending = deferred<unknown>();
    const entered = deferred<void>();
    let context!: ToolContext;
    const engine = new Engine(
      store,
      {
        kind: "model",
        async step() {
          return {
            type: "tool_calls",
            calls: [{ id: "slow", name: "slow", args: {} }],
          };
        },
      },
      "http://127.0.0.1:1",
      1,
      150,
      {
        slow: {
          description: "Uncooperative I/O",
          schema: z.object({}).strict(),
          execute(_args, ctx) {
            context = ctx;
            entered.resolve();
            return pending.promise;
          },
        },
      },
    );
    const id = await queued();
    try {
      await engine.pump();
      await entered.promise;
      await terminal(engine);
      expect(context.signal.aborted).toBe(true);
      const snapshot = await store.snapshot(id, owner);
      expect(snapshot.dialog.run).toMatchObject({
        status: "failed",
        error: { code: "run_timeout" },
      });
      const tool = () =>
        store.pool.query(
          "SELECT status,result FROM tool_calls WHERE run_id=$1",
          [snapshot.dialog.run!.id],
        );
      const before = (await tool()).rows;
      expect(before).toEqual([{ status: "failed", result: null }]);
      pending.reject(new Error("late tool rejection"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await tool()).rows).toEqual(before);
      expect(await store.snapshot(id, owner)).toEqual(snapshot);
    } finally {
      pending.resolve(null);
      await engine.stop();
    }
  });

  it("applies the original deadline to a repair that ignores cancellation", async () => {
    const pending = deferred<AgentOutput>();
    const entered = deferred<void>();
    const engine = new Engine(
      store,
      {
        kind: "agent",
        async run(context) {
          if (!context.repair) return { text: "invalid", a2uiJson: "broken" };
          entered.resolve();
          return pending.promise;
        },
      },
      "http://127.0.0.1:1",
      1,
      150,
    );
    const id = await queued();
    try {
      await engine.pump();
      await entered.promise;
      await terminal(engine);
      expect((await store.get(id, owner)).run).toMatchObject({
        status: "failed",
        error: { code: "run_timeout" },
      });
      expect(
        (await store.snapshot(id, owner)).messages.every(
          (m) => m.role !== "assistant",
        ),
      ).toBe(true);
    } finally {
      pending.resolve(result);
      await engine.stop();
    }
  });

  it("cancels a hung adapter without waiting for the run deadline", async () => {
    const pending = deferred<AgentOutput>();
    const entered = deferred<void>();
    const engine = new Engine(
      store,
      {
        kind: "agent",
        async run() {
          entered.resolve();
          return pending.promise;
        },
      },
      "http://127.0.0.1:1",
      1,
      60000,
    );
    const id = await queued();
    try {
      await engine.pump();
      await entered.promise;
      const run = (await store.get(id, owner)).run!;
      await store.cancel(owner, id, run.id, randomUUID());
      engine.cancel(run.id);
      await terminal(engine);
      expect((await store.get(id, owner)).run?.status).toBe("cancelled");
    } finally {
      pending.resolve(result);
      await engine.stop();
    }
  });

  it.each(["hung", "cooperative"])(
    "closes a server with a %s adapter and fences late tool calls",
    async (mode) => {
      const pending = deferred<AgentOutput>();
      const entered = deferred<void>();
      let call!: ToolCaller;
      let cleaned = false;
      const config = configFrom({ DATABASE_URL: database, AUTH_MODE: "demo" });
      config.PORT = 0;
      const server = await startServer(config, {
        handleSignals: false,
        adapter: {
          kind: "agent",
          async run(_context, caller, signal) {
            call = caller;
            entered.resolve();
            if (mode === "cooperative")
              signal.addEventListener(
                "abort",
                () => {
                  setTimeout(() => {
                    cleaned = true;
                    pending.resolve(result);
                  }, 50);
                },
                { once: true },
              );
            return pending.promise;
          },
        },
      });
      let id: string;
      try {
        id = (
          (await server.store.create(owner, randomUUID())) as {
            dialogId: string;
          }
        ).dialogId;
        await server.store.accept(owner, id, randomUUID(), { text: "stop" });
        await server.engine.pump();
        await entered.promise;
        const start = Date.now();
        const closing = server.close();
        const watchdog = setTimeout(() => pending.resolve(result), 3500);
        try {
          await closing;
        } finally {
          clearTimeout(watchdog);
        }
        expect(Date.now() - start).toBeLessThan(3200);
        expect(server.app.server.listening).toBe(false);
        if (mode === "cooperative") expect(cleaned).toBe(true);
        await expect(call("late", {}, "late")).rejects.toMatchObject({
          code: "interrupted",
        });
        const before = await store.snapshot(id, owner);
        expect(before.dialog.run).toMatchObject({
          status: "failed",
          error: { code: "interrupted" },
        });
        pending.resolve(result);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await store.snapshot(id, owner)).toEqual(before);
      } finally {
        pending.resolve(result);
        await server.close();
      }
    },
  );
});
