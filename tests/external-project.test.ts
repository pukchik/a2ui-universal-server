import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

it.skipIf(!process.env.TEST_DATABASE_URL).each(["normal", "hung"])(
  "runs the %s application outside the checkout and exits cleanly on SIGTERM",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "a2ui-external-project-"));
    const sourceUrl = new URL("../examples/notes/app.ts", import.meta.url);
    const source = (await readFile(sourceUrl, "utf8")).replace(
      /from "([^"]+)"/g,
      (match, specifier: string) => {
        if (specifier.startsWith("."))
          return `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`;
        if (specifier === "zod")
          return `from ${JSON.stringify(import.meta.resolve("zod"))}`;
        return match;
      },
    );
    await writeFile(
      join(directory, "application.mjs"),
      transpileModule(source, {
        compilerOptions: {
          module: ModuleKind.ESNext,
          target: ScriptTarget.ES2023,
        },
      }).outputText,
    );
    const serverUrl = new URL("../server/index.ts", import.meta.url).href;
    await writeFile(
      join(directory, "main.mjs"),
      `
import { startServer, configFrom } from ${JSON.stringify(serverUrl)};
import { notesOptions } from "./application.mjs";
const config = configFrom({ ...process.env, AUTH_MODE: "custom" });
config.PORT = 0;
const options = notesOptions();
if (process.env.A2UI_TEST_HANG === "1") options.adapter = {
  kind: "agent",
  async run() {
    setInterval(() => {}, 1000);
    console.log("HUNG_HANDLER_ENTERED");
    return new Promise(() => {});
  },
};
const server = await startServer(config, { ...options, handleSignals: true });
const address = server.app.server.address();
config.PUBLIC_URL = "http://localhost:" + address.port;
console.log("READY " + JSON.stringify({ origin: config.PUBLIC_URL }));
`,
    );
    const child = spawn(process.execPath, [join(directory, "main.mjs")], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        NODE_NO_WARNINGS: "1",
        A2UI_TEST_HANG: mode === "hung" ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-8000);
    });
    child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-4000);
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("External startup timed out: " + errors)),
          5000,
        );
        child.stdout.on("data", (chunk) => {
          const match = output.match(/READY (.+)\n/);
          if (match) {
            clearTimeout(timeout);
            resolve(JSON.parse(match[1]).origin);
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("External startup failed: " + errors));
        });
      });
      const login = await fetch(origin + "/auth/login");
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const session = await (
        await fetch(origin + "/v1/session", { headers: { cookie } })
      ).json();
      async function request(path: string, body?: object) {
        const response = await fetch(origin + path, {
          method: body ? "POST" : "GET",
          headers: {
            cookie,
            origin,
            "content-type": "application/json",
            "x-csrf-token": session.csrf,
          },
          body: body
            ? JSON.stringify({ commandId: crypto.randomUUID(), ...body })
            : undefined,
        });
        expect(response.ok).toBe(true);
        return response.json();
      }
      const { dialogId } = await request("/v1/dialogs", {});
      const snapshot = () => request(`/v1/dialogs/${dialogId}/snapshot`);
      const done = async () => {
        await expect
          .poll(async () => (await snapshot()).dialog.run?.status, {
            timeout: 5000,
          })
          .toMatch(/succeeded|failed/);
        const result = await snapshot();
        expect(result.dialog.run.status).toBe("succeeded");
        return result;
      };
      await request(`/v1/dialogs/${dialogId}/messages`, {
        text: "Мои заметки",
      });
      if (mode === "hung") {
        await expect
          .poll(() => output.includes("HUNG_HANDLER_ENTERED"), {
            timeout: 5000,
          })
          .toBe(true);
        return;
      }
      const first = await done();
      expect(JSON.stringify(first.dialog.ui)).toContain("Заметка Алисы");
      expect(JSON.stringify(first.dialog.ui)).not.toContain("Заметка Боба");
      await request(`/v1/dialogs/${dialogId}/actions`, {
        uiRevision: first.dialog.ui.revision,
        action: {
          surfaceId: "notes",
          componentId: "alice-1-button",
          name: "open_note",
          context: { id: "alice-1" },
        },
      });
      const second = await done();
      expect(second.dialog.ui.revision).toBe(2);
      expect((await snapshot()).dialog.ui).toEqual(second.dialog.ui);
    } finally {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      const result = await exit;
      clearTimeout(timeout);
      expect(result.code, errors).toBe(0);
      expect(result.signal).toBeNull();
    }
  },
);
