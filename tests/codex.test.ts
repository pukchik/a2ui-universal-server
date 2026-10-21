import { it, expect } from "vitest";
import { resolve } from "node:path";
import { codexAdapter } from "../apps/server/src/adapters/codex.ts";
import type { AgentContext } from "../apps/server/src/adapters/types.ts";
const adapter = codexAdapter({
  executable: process.execPath,
  profileDir: "/tmp/a2ui-test-profile",
  prefixArgs: [resolve("tests/fixtures/codex.mjs")],
});
const context = (text: string) =>
  ({
    run: {
      id: "run",
      dialogId: "dialog",
      generation: "generation",
      status: "running",
      input: { text },
    },
    dialog: { id: "dialog", ui: { messages: [], revision: 0 } },
    history: [],
    toolUrl: "http://127.0.0.1:1/internal/mcp",
    token: "test",
  }) as unknown as AgentContext;
const denied = async () => {
  throw new Error("unexpected direct tool call");
};
it("reads JSONL and final output from a child process", async () => {
  expect(
    await adapter.run(context("hello"), denied, new AbortController().signal),
  ).toEqual({ text: "fixture result", a2uiJson: "[]" });
});
for (const scenario of ["jsonl", "tool", "exit", "missing"])
  it(`rejects ${scenario} CLI failure`, async () => {
    await expect(
      adapter.run(
        context(`fixture-${scenario}`),
        denied,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
it("stops the CLI process on cancellation", async () => {
  const controller = new AbortController();
  const result = adapter.run(
    context("fixture-hang"),
    denied,
    controller.signal,
  );
  setTimeout(() => controller.abort(new Error("cancelled")), 100);
  await expect(result).rejects.toThrow("cancelled");
});
