import { it, expect } from "vitest";
import {
  CatalogRegistry,
  defaultCatalog,
} from "../packages/catalogs/src/index.ts";
import { runAdapter } from "../server/adapters/types.ts";
import type { AgentContext, ModelAdapter } from "../server/adapters/types.ts";
it("caches catalog loads and preserves old snapshots across explicit refresh", async () => {
  let n = 0;
  const registry = new CatalogRegistry();
  registry.register({
    name: "local",
    load: async () => ({
      catalogId: "demo",
      version: String(++n),
      components: { Text: { type: "object" } },
    }),
  });
  const first = await registry.get("local");
  expect((await registry.get("local")).digest).toBe(first.digest);
  expect(n).toBe(1);
  const second = await registry.refresh("local");
  expect(second.digest).not.toBe(first.digest);
  expect(first.version).toBe("1");
  first.document.components = {};
  expect((await registry.get("local")).document.components).not.toEqual({});
});
it("prepares a pinned catalog from the editable component files", async () => {
  const catalog = await defaultCatalog();
  expect(catalog.protocol).toBe("v0.9.1");
  expect(catalog.digest).toHaveLength(64);
  expect(Object.keys(catalog.document.components as object)).toContain(
    "TextField",
  );
});
it("runs the tool loop only for a model adapter", async () => {
  let steps = 0,
    calls = 0;
  const adapter: ModelAdapter = {
    kind: "model",
    async step(_context, results) {
      steps++;
      return results.length
        ? { type: "output", output: { text: "done", a2uiJson: "[]" } }
        : { type: "tool_calls", calls: [{ id: "1", name: "read", args: {} }] };
    },
  };
  const output = await runAdapter(
    adapter,
    {} as AgentContext,
    async () => {
      calls++;
      return { ok: true };
    },
    new AbortController().signal,
  );
  expect(output.text).toBe("done");
  expect(steps).toBe(2);
  expect(calls).toBe(1);
});
it("delegates a ready agent without running a second loop", async () => {
  let runs = 0;
  await runAdapter(
    {
      kind: "agent",
      async run() {
        runs++;
        return { text: "done", a2uiJson: "[]" };
      },
    },
    {} as AgentContext,
    async () => {
      throw Error("unexpected");
    },
    new AbortController().signal,
  );
  expect(runs).toBe(1);
});
