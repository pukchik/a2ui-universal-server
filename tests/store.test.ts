import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../server/storage/store.ts";
import { productUi } from "../demo/server/tools.ts";
import { Engine } from "../server/engine.ts";
import { z } from "zod";
import { CatalogRegistry } from "../packages/catalogs/src/index.ts";
import type { Adapter } from "../server/adapters/types.ts";
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
  it("validates component properties against the dialog's pinned catalog", async () => {
    const original = store.catalog!;
    const previousDialog = await create();
    const edited = structuredClone(original.document);
    const components = edited.components as Record<string, { allOf: any[] }>;
    components.Text.allOf.at(-1).properties.variant.enum = ["body"];
    const registry = new CatalogRegistry();
    registry.register({ name: "edited", load: async () => edited });
    let restrictedDialog: string;
    try {
      store.catalog = await registry.get("edited");
      restrictedDialog = await create();
    } finally {
      store.catalog = original;
    }
    await store.accept(user, previousDialog, randomUUID(), {
      text: "original",
    });
    const previousRun = (await store.claim())!;
    await expect(
      store.complete(previousRun, "heading", productUi()),
    ).resolves.toBeUndefined();
    await store.accept(user, restrictedDialog, randomUUID(), {
      text: "edited",
    });
    const restrictedRun = (await store.claim())!;
    try {
      await expect(
        store.complete(restrictedRun, "heading", productUi()),
      ).rejects.toMatchObject({ code: "invalid_component" });
      expect((await store.get(restrictedDialog, user)).ui.revision).toBe(0);
    } finally {
      await store.fail(restrictedRun, "test", "Finished validation test");
    }
    expect(
      (await store.snapshot(previousDialog, user)).dialog.catalog?.digest,
    ).toBe(original.digest);
    expect(
      (await store.snapshot(restrictedDialog, user)).dialog.catalog?.digest,
    ).not.toBe(original.digest);
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
  it.each([
    ["malformed JSON", "invalid"],
    ["JSON without an A2UI array", "{}"],
    [
      "an invalid A2UI message",
      JSON.stringify([{ version: "v0.9.1", createSurface: { surfaceId: 42 } }]),
    ],
  ])("repairs %s once with tools disabled", async (_name, invalid) => {
    const id = await create();
    let n = 0;
    const adapter: Adapter = {
      kind: "agent",
      async run(context, call) {
        n++;
        if (n === 1) return { text: "bad", a2uiJson: invalid };
        expect(context.repair).toBeDefined();
        await expect(call("get_product", {}, "no")).rejects.toThrow();
        return { text: "fixed", a2uiJson: JSON.stringify(productUi()) };
      },
    };
    const engine = new Engine(store, adapter, "http://127.0.0.1:1", 1);
    await store.accept(user, id, randomUUID(), { text: "repair" });
    try {
      await engine.pump();
      await Promise.all([...engine.active.values()].map((v) => v.task));
      const snapshot = await store.snapshot(id, user);
      expect(snapshot.dialog.run?.status).toBe("succeeded");
      expect(snapshot.dialog.ui.revision).toBe(1);
      expect(snapshot.messages.at(-1)?.text).toBe("fixed");
      expect(snapshot.messages.some((message) => message.text === "bad")).toBe(
        false,
      );
      expect(n).toBe(2);
    } finally {
      await engine.stop();
    }
  });
  it.each([
    ["malformed JSON", "invalid"],
    ["valid JSON that is not A2UI", "{}"],
  ])(
    "preserves the previous UI when repair still returns %s",
    async (_name, invalid) => {
      const id = await create();
      await store.accept(user, id, randomUUID(), { text: "initial" });
      await store.complete((await store.claim())!, "initial UI", productUi());
      const previous = (await store.get(id, user)).ui;
      let calls = 0;
      const adapter: Adapter = {
        kind: "agent",
        async run(context) {
          calls++;
          expect(Boolean(context.repair)).toBe(calls === 2);
          return { text: "must not be published", a2uiJson: invalid };
        },
      };
      const engine = new Engine(store, adapter, "http://127.0.0.1:1", 1);
      await store.accept(user, id, randomUUID(), { text: "broken answer" });
      try {
        await engine.pump();
        await Promise.all([...engine.active.values()].map((v) => v.task));
        const snapshot = await store.snapshot(id, user);
        expect(snapshot.dialog.run?.status).toBe("failed");
        expect(snapshot.dialog.run?.error?.code).toBe("invalid_ui");
        expect(snapshot.dialog.ui).toEqual(previous);
        expect(
          snapshot.messages.some(
            (message) => message.text === "must not be published",
          ),
        ).toBe(false);
        expect(
          (await store.events(id, user, 0)).filter(
            (event) => event.type === "ui.updated",
          ),
        ).toHaveLength(1);
        expect(calls).toBe(2);
      } finally {
        await engine.stop();
      }
    },
  );
  it("executes only the application's supplied tools", async () => {
    const id = await create();
    const adapter: Adapter = {
      kind: "agent",
      async run(_context, call) {
        await expect(call("get_product", {}, "denied")).rejects.toMatchObject({
          code: "tool_denied",
        });
        await expect(call("toString", {}, "inherited")).rejects.toMatchObject({
          code: "tool_denied",
        });
        const result = await call("echo", { text: "application data" }, "echo");
        return { text: String(result), a2uiJson: "[]" };
      },
    };
    const engine = new Engine(store, adapter, "http://127.0.0.1:1", 1, 120000, {
      echo: {
        description: "Return the supplied text",
        schema: z.object({ text: z.string() }).strict(),
        execute: async (args: { text: string }) => args.text,
      },
    });
    await store.accept(user, id, randomUUID(), { text: "custom application" });
    try {
      await engine.pump();
      await Promise.all([...engine.active.values()].map((v) => v.task));
      const snapshot = await store.snapshot(id, user);
      expect(snapshot.dialog.run?.status).toBe("succeeded");
      expect(snapshot.messages.at(-1)?.text).toBe("application data");
    } finally {
      await engine.stop();
    }
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
