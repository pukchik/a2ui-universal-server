import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../apps/server/src/storage/store.ts";
import { productUi } from "../apps/server/src/tools.ts";
import { Engine } from "../apps/server/src/engine.ts";
import type { Adapter } from "../apps/server/src/adapters/types.ts";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL commands and execution", () => {
  const store = new Store(url!);
  const user = `test-${randomUUID()}`;
  beforeAll(() => store.migrate());
  afterAll(() => store.close());
  const create = async () =>
    String(
      ((await store.create(user, randomUUID())) as { dialogId: string })
        .dialogId,
    );
  it("deduplicates concurrent create and message commands", async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      store.create(user, key),
      store.create(user, key),
    ]);
    expect(a).toEqual(b);
    const id = (a as { dialogId: string }).dialogId;
    const command = randomUUID();
    const [first, second] = await Promise.all([
      store.accept(user, id, command, { text: "lamps" }),
      store.accept(user, id, command, { text: "lamps" }),
    ]);
    expect(first).toEqual(second);
    await expect(
      store.accept(user, id, command, { text: "different" }),
    ).rejects.toMatchObject({ code: "command_conflict" });
    await store.cancel(
      user,
      id,
      (first as { runId: string }).runId,
      randomUUID(),
    );
    expect(await store.accept(user, id, command, { text: "lamps" })).toEqual(
      first,
    );
  });
  it("rejects busy dialogs and another user", async () => {
    const id = await create();
    const a = (await store.accept(user, id, randomUUID(), { text: "one" })) as {
      runId: string;
    };
    await expect(
      store.accept(user, id, randomUUID(), { text: "two" }),
    ).rejects.toMatchObject({ code: "dialog_busy" });
    await expect(store.get(id, "stranger")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.cancel("stranger", id, a.runId, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    await store.cancel(user, id, a.runId, randomUUID());
  });
  it("commits UI and ordered events together and rejects stale actions", async () => {
    const id = await create();
    await store.accept(user, id, randomUUID(), { text: "products" });
    const run = (await store.claim())!;
    expect(run.dialogId).toBe(id);
    await store.complete(run, "found", productUi());
    const snapshot = await store.snapshot(id, user);
    expect(snapshot.dialog.ui.revision).toBe(1);
    expect(snapshot.dialog.run?.status).toBe("succeeded");
    const events = await store.events(id, user, 0);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.at(-1)?.type).toBe("run.succeeded");
    await expect(
      store.accept(
        user,
        id,
        randomUUID(),
        {
          action: {
            surfaceId: "products",
            componentId: "button-lamp-1",
            name: "show_product",
            context: { productId: "lamp-1" },
          },
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "stale_ui" });
  });
  it("never lets a cancelled executor publish UI or use tools", async () => {
    const id = await create();
    const accepted = (await store.accept(user, id, randomUUID(), {
      text: "cancel me",
    })) as { runId: string };
    const run = (await store.claim())!;
    await store.cancel(user, id, accepted.runId, randomUUID());
    await expect(
      store.complete(run, "late", productUi()),
    ).rejects.toMatchObject({ code: "run_inactive" });
    await expect(
      store.toolStart(run, "x", "search_products", {}),
    ).rejects.toMatchObject({ code: "run_inactive" });
    expect((await store.get(id, user)).ui.revision).toBe(0);
  });
  it("records and deduplicates tools, refusing different arguments", async () => {
    const id = await create();
    await store.accept(user, id, randomUUID(), { text: "tools" });
    const run = (await store.claim())!;
    expect(
      await store.toolStart(run, "call", "get_product", { id: "lamp-1" }),
    ).toEqual({ cached: false });
    await store.toolEnd(run, "call", { id: "lamp-1" });
    expect(
      await store.toolStart(run, "call", "get_product", { id: "lamp-1" }),
    ).toEqual({ cached: true, result: { id: "lamp-1" } });
    await expect(
      store.toolStart(run, "call", "get_product", { id: "lamp-2" }),
    ).rejects.toMatchObject({ code: "tool_conflict" });
    await store.fail(run, "test", "test");
  });
  it("retries one malformed UI answer with tools disabled", async () => {
    const id = await create();
    let n = 0;
    const adapter: Adapter = {
      kind: "agent",
      async run(context, call) {
        n++;
        if (n === 1) return { text: "bad", a2uiJson: "invalid" };
        expect(context.repair).toBeDefined();
        await expect(call("get_product", {}, "no")).rejects.toThrow();
        return { text: "fixed", a2uiJson: JSON.stringify(productUi()) };
      },
    };
    const engine = new Engine(store, adapter, "http://127.0.0.1:1", 1);
    await store.accept(user, id, randomUUID(), { text: "repair" });
    await engine.pump();
    await Promise.all([...engine.active.values()].map((v) => v.task));
    expect((await store.get(id, user)).run?.status).toBe("succeeded");
    expect(n).toBe(2);
    await engine.stop();
  });
  it("supports isolated one-shot generations without dialog continuation", async () => {
    const key = randomUUID();
    const result = (await store.generate(user, key, "one shot")) as {
      generationId: string;
      runId: string;
    };
    expect(await store.generate(user, key, "one shot")).toEqual(result);
    expect(
      (await store.list(user)).some((d) => d.id === result.generationId),
    ).toBe(false);
    await expect(
      store.accept(user, result.generationId, randomUUID(), {
        text: "continue",
      }),
    ).rejects.toMatchObject({ code: "generation_is_one_shot" });
    const run = (await store.claim())!;
    await store.complete(run, "one answer", productUi());
    const snapshot = await store.snapshot(result.generationId, user);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.dialog.catalog?.digest).toHaveLength(64);
  });
  it("marks interrupted runs failed after restart and preserves queued runs", async () => {
    const id = await create();
    await store.accept(user, id, randomUUID(), { text: "running" });
    await store.claim();
    await store.acquireLock(() => {});
    expect((await store.get(id, user)).run?.error?.code).toBe("interrupted");
  });
});
