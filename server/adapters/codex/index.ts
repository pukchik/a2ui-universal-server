import { Codex } from "@openai/codex-sdk";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AppError } from "../../../packages/core/src/errors.ts";
import { preparePrompt } from "../../prompt.ts";
import type { AgentAdapter, AgentOutput } from "../types.ts";
export type CodexOptions = {
  executable: string;
  profileDir: string;
  model?: string;
  runtimeDir?: string;
  maxBytes?: number;
};
const outputSchema = {
  type: "object",
  properties: { text: { type: "string" }, a2uiJson: { type: "string" } },
  required: ["text", "a2uiJson"],
  additionalProperties: false,
};
async function waitForProcess(dir: string) {
  // SDK generator cleanup sends SIGTERM but does not await the CLI process tree.
  for (let attempt = 0; attempt < 200; attempt++) {
    let state;
    try {
      state = await readFile(join(dir, "process.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (state.includes('"done":true')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new AppError(
    502,
    "codex_shutdown",
    "Процесс Codex не подтвердил остановку.",
  );
}
export function codexAdapter(options: CodexOptions): AgentAdapter {
  return {
    kind: "agent",
    async run(context, _callTool, signal) {
      if (signal.aborted) throw signal.reason;
      const base = options.runtimeDir ?? join(tmpdir(), "a2ui-codex");
      await mkdir(base, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(base, "run-"));
      const schema = join(dir, "output.schema.json");
      // The launcher passes this schema to CLI; the SDK has no ephemeral/ignore-config flags.
      await writeFile(schema, JSON.stringify(outputSchema), { mode: 0o600 });
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const codex = new Codex({
          codexPathOverride: fileURLToPath(
            new URL("./codex-process.mjs", import.meta.url),
          ),
          env: {
            PATH: process.env.PATH ?? "",
            LANG: "C.UTF-8",
            CODEX_HOME: resolve(options.profileDir),
            A2UI_CODEX_BIN: options.executable,
            A2UI_CODEX_DIR: dir,
            A2UI_CODEX_SCHEMA: schema,
            A2UI_CODEX_MAX_BYTES: String(options.maxBytes ?? 512000),
            ...(!context.repair ? { A2UI_RUN_TOKEN: context.token } : {}),
          },
          config: {
            features: {
              shell_tool: false,
              multi_agent: false,
              js_repl: false,
              apps: false,
            },
            ...(!context.repair
              ? {
                  mcp_servers: {
                    project: {
                      url: context.toolUrl,
                      bearer_token_env_var: "A2UI_RUN_TOKEN",
                      required: true,
                    },
                  },
                }
              : {}),
          },
        });
        const thread = codex.startThread({
          model: options.model,
          workingDirectory: dir,
          skipGitRepoCheck: true,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          webSearchMode: "disabled",
        });
        const { events } = await thread.runStreamed(preparePrompt(context), {
          signal: controller.signal,
        });
        let response = "";
        let completed = false;
        for await (const event of events) {
          if (signal.aborted) throw signal.reason;
          if (event.type === "turn.failed" || event.type === "error")
            throw new AppError(
              502,
              "codex_failed",
              "Codex завершился с ошибкой. Проверьте авторизацию и доступность модели.",
            );
          if ("item" in event) {
            if (
              ["command_execution", "file_change", "web_search"].includes(
                event.item.type,
              )
            )
              throw new AppError(
                502,
                "unexpected_tool",
                "Codex попытался использовать инструмент вне MCP проекта.",
              );
            if (
              event.item.type === "mcp_tool_call" &&
              (context.repair || event.item.server !== "project")
            )
              throw new AppError(
                502,
                "unexpected_tool",
                "Codex обратился к недопустимому MCP.",
              );
            if (
              event.type === "item.completed" &&
              event.item.type === "agent_message"
            )
              response = event.item.text;
          }
          if (event.type === "turn.completed") completed = true;
        }
        if (!completed || !response)
          throw new AppError(502, "missing_agent_output");
        if (Buffer.byteLength(response) > 128000)
          throw new AppError(422, "agent_output_limit");
        const value: unknown = JSON.parse(response);
        if (
          !value ||
          typeof value !== "object" ||
          !("text" in value) ||
          !("a2uiJson" in value) ||
          typeof value.text !== "string" ||
          typeof value.a2uiJson !== "string" ||
          value.text.length > 12000 ||
          Object.keys(value).some((key) => !["text", "a2uiJson"].includes(key))
        )
          throw new AppError(422, "invalid_agent_output");
        return value as AgentOutput;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof AppError) throw error;
        if (
          error instanceof Error &&
          /Codex Exec exited with code 73:/.test(error.message)
        )
          throw new AppError(422, "cli_output_limit");
        // SDK errors may include CLI stderr or raw events: never expose those to the client.
        throw new AppError(
          502,
          "codex_process",
          "Не удалось получить итоговый ответ Codex. Проверьте служебную авторизацию CLI.",
        );
      } finally {
        signal.removeEventListener("abort", abort);
        await waitForProcess(dir);
      }
    },
  };
}
