#!/usr/bin/env node
// Process policy only. The official SDK owns the CLI protocol and event parsing.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const {
  A2UI_CODEX_BIN: binary,
  A2UI_CODEX_DIR: cwd,
  A2UI_CODEX_SCHEMA: schema,
  A2UI_CODEX_MAX_BYTES: limit,
  ...env
} = process.env;
if (!binary || !cwd || !schema || process.argv[2] !== "exec") process.exit(70);
const stateFile = join(cwd, "process.json");
writeFileSync(stateFile, JSON.stringify({ done: false }), { mode: 0o600 });
const args = [
  "exec",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--output-schema",
  schema,
  ...process.argv.slice(3),
];
const child = spawn(binary, args, {
  cwd,
  env,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});
let bytes = 0;
let failed = false;
let killTimer;
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
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("error", stop);
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
const forward = (output, chunk) => {
  bytes += chunk.length;
  if (bytes > Number(limit)) {
    failed = true;
    stop();
    return;
  }
  if (!failed && !output.write(chunk)) child.stdout.pause();
};
child.stdout.on("data", (chunk) => forward(process.stdout, chunk));
// Do not retain unbounded or sensitive CLI diagnostics in SDK memory.
child.stderr.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > Number(limit)) {
    failed = true;
    stop();
  }
});
process.stdout.on("drain", () => child.stdout.resume());
process.stdout.on("error", stop);
child.on("error", () => {
  process.exitCode = 71;
});
child.on("close", (code) => {
  if (killTimer) clearTimeout(killTimer);
  kill(true);
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.exitCode = failed ? 73 : (process.exitCode ?? code ?? 72);
  writeFileSync(stateFile, JSON.stringify({ done: true }));
});
