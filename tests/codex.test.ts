import { it, expect } from "vitest";
import { resolve, join } from "node:path";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { codexAdapter } from "../server/adapters/codex.ts";
import type { AgentContext } from "../server/adapters/types.ts";
const options = {
  executable: resolve("tests/fixtures/codex.mjs"),
  profileDir: "/tmp/a2ui-test-profile",
};
const adapter = codexAdapter(options);
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
it("uses the official SDK to stream CLI events and collect the structured final response", async () => {
  expect(
    await adapter.run(context("hello"), denied, new AbortController().signal),
  ).toEqual({ text: "fixture result", a2uiJson: "[]" });
});
for (const scenario of [
  "jsonl",
  "tool",
  "exit",
  "missing",
  "incomplete",
  "invalid-output",
  "mcp",
])
  it(`rejects ${scenario} CLI failure without leaking raw diagnostics`, async () => {
    await expect(
      adapter.run(
        context(`fixture-${scenario}`),
        denied,
        new AbortController().signal,
      ),
    ).rejects.not.toThrow("PRIVATE_DIAGNOSTICS_MUST_NOT_LEAK");
  });
it("keeps MCP configuration and environment scoped to the run, including repair", async () => {
  process.env.A2UI_PRIVATE_TEST = "must not inherit";
  try {
    for (const repair of [false, true]) {
      const ctx = context("fixture-config");
      if (repair)
        ctx.repair = { output: "{}", error: "invalid_ui", results: [] };
      const result = await adapter.run(
        ctx,
        denied,
        new AbortController().signal,
      );
      const info = JSON.parse(result.text);
      expect(info.privateEnvPresent).toBe(false);
      expect(info.tokenPresent).toBe(!repair);
      expect(info.args).toEqual(
        expect.arrayContaining([
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
        ]),
      );
      expect(info.args.join(" ")).toContain('approval_policy="never"');
      expect(info.args.join(" ")).toContain("features.shell_tool=false");
      expect(info.args.join(" ")).toContain("features.multi_agent=false");
      expect(info.args.join(" ")).toContain('web_search="disabled"');
      expect(info.args.join(" ").includes("mcp_servers.project.url=")).toBe(
        !repair,
      );
      expect(info.schema.required).toEqual(["text", "a2uiJson"]);
      expect(info.cwd).not.toBe(process.cwd());
    }
  } finally {
    delete process.env.A2UI_PRIVATE_TEST;
  }
});
it("rejects MCP calls during repair even if the CLI emits one", async () => {
  const ctx = context("fixture-mcp-repair");
  ctx.repair = { output: "{}", error: "invalid_ui", results: [] };
  await expect(
    adapter.run(ctx, denied, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unexpected_tool" });
});
for (const scenario of ["limit", "stderr-limit"])
  it(`limits raw ${scenario} before the SDK buffers it`, async () => {
    await expect(
      codexAdapter({ ...options, maxBytes: 10000 }).run(
        context(`fixture-${scenario}`),
        denied,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
it("stops a CLI process group that ignores SIGTERM on cancellation", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "a2ui-cancel-test-"));
  const controller = new AbortController();
  const result = codexAdapter({ ...options, runtimeDir }).run(
    context("fixture-hang"),
    denied,
    controller.signal,
  );
  const rejected = expect(result).rejects.toThrow("cancelled");
  let pids: number[] | undefined;
  for (let i = 0; i < 200 && !pids; i++) {
    for (const dir of await readdir(runtimeDir)) {
      try {
        pids = JSON.parse(
          await readFile(join(runtimeDir, dir, "fixture-pids.json"), "utf8"),
        );
      } catch {}
    }
    if (!pids) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(pids).toHaveLength(2);
  controller.abort(new Error("cancelled"));
  await rejected;
  for (const pid of pids!) {
    let state = "";
    try {
      state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1][0];
    } catch {}
    expect(["", "Z"]).toContain(state);
  }
});
