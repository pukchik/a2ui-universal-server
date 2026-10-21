import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "../../../../packages/core/src/errors.ts";
import { preparePrompt } from "../prompt.ts";
import type { AgentAdapter, AgentContext, AgentOutput } from "./types.ts";
export type CodexOptions = {
  executable: string;
  profileDir: string;
  model?: string;
  runtimeDir?: string;
  prefixArgs?: string[];
  maxBytes?: number;
};
export function codexAdapter(options: CodexOptions): AgentAdapter {
  return {
    kind: "agent",
    async run(context, _callTool, signal) {
      if (signal.aborted) throw signal.reason;
      const base = options.runtimeDir ?? join(tmpdir(), "a2ui-codex");
      await mkdir(base, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(base, "run-"));
      const schema = join(dir, "output.schema.json");
      const output = join(dir, "output.json");
      await writeFile(
        schema,
        JSON.stringify({
          type: "object",
          properties: {
            text: { type: "string" },
            a2uiJson: { type: "string" },
          },
          required: ["text", "a2uiJson"],
          additionalProperties: false,
        }),
        { mode: 0o600 },
      );
      const args = [
        ...(options.prefixArgs ?? []),
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-schema",
        schema,
        "--output-last-message",
        output,
        "--cd",
        dir,
        "-c",
        'approval_policy="never"',
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.js_repl=false",
        "-c",
        "features.apps=false",
        "-c",
        'web_search="disabled"',
      ];
      if (options.model) args.push("--model", options.model);
      if (!context.repair)
        args.push(
          "-c",
          `mcp_servers.project.url=${JSON.stringify(context.toolUrl)}`,
          "-c",
          'mcp_servers.project.bearer_token_env_var="A2UI_RUN_TOKEN"',
          "-c",
          "mcp_servers.project.required=true",
        );
      args.push("-");
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        CODEX_HOME: resolve(options.profileDir),
        A2UI_RUN_TOKEN: context.repair ? undefined : context.token,
      };
      // Never inherit SQL credentials, unrelated tokens or the developer's shell environment.
      const child = spawn(options.executable, args, {
        cwd: dir,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let bytes = 0,
        buffer = "",
        stderr = "",
        failure: Error | undefined,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (force = false) => {
        if (child.pid)
          try {
            process.kill(
              process.platform === "win32" ? child.pid : -child.pid,
              force ? "SIGKILL" : "SIGTERM",
            );
          } catch {}
      };
      const stop = () => {
        kill();
        killTimer ??= setTimeout(() => kill(true), 1500);
        killTimer.unref();
      };
      const abort = () => {
        failure = new AppError(409, "cancelled");
        stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const consume = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 512000)) {
          failure = new AppError(422, "cli_output_limit");
          stop();
          return;
        }
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "turn.failed" || event.type === "error")
              failure = new AppError(
                502,
                "codex_failed",
                "Codex завершился с ошибкой. Проверьте авторизацию и доступность модели.",
              );
            if (
              ["command_execution", "file_change", "web_search"].includes(
                event.item?.type,
              )
            ) {
              failure = new AppError(
                502,
                "unexpected_tool",
                "Codex попытался использовать инструмент вне MCP проекта.",
              );
              stop();
            }
          } catch {
            failure = new AppError(502, "invalid_jsonl");
            stop();
          }
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2048);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(preparePrompt(context));
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (buffer.trim()) {
          failure ??= new AppError(
            502,
            "invalid_jsonl",
            "Оборванный поток событий Codex.",
          );
        }
        if (signal.aborted) throw signal.reason;
        if (failure) throw failure;
        if (code !== 0)
          throw new AppError(
            502,
            "codex_exit",
            `Codex завершился с кодом ${code}. Проверьте служебную авторизацию CLI.`,
          );
        if ((await stat(output)).size > 128000)
          throw new AppError(422, "agent_output_limit");
        const value = JSON.parse(await readFile(output, "utf8")) as AgentOutput;
        if (
          typeof value.text !== "string" ||
          typeof value.a2uiJson !== "string" ||
          value.text.length > 12000
        )
          throw new AppError(422, "invalid_agent_output");
        return value;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof AppError) throw error;
        throw new AppError(
          502,
          "codex_process",
          error instanceof Error && "code" in error
            ? `Ошибка процесса Codex: ${error.code}`
            : "Не удалось получить итоговый ответ Codex.",
        );
      } finally {
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        kill(true);
        void stderr;
      }
    },
  };
}
