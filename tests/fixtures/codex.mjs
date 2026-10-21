#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const emit = (event) => console.log(JSON.stringify(event));
const complete = (text) => {
  emit({
    type: "item.completed",
    item: { id: "answer", type: "agent_message", text },
  });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  });
};
if (input.includes("fixture-hang")) {
  process.on("SIGTERM", () => {});
  const descendant = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    { stdio: "ignore" },
  );
  fs.writeFileSync(
    "fixture-pids.json",
    JSON.stringify([process.pid, descendant.pid]),
  );
  emit({ type: "turn.started" });
  setInterval(() => {}, 1000);
} else if (input.includes("fixture-jsonl")) {
  console.log("invalid-jsonl");
} else if (input.includes("fixture-tool")) {
  emit({ type: "item.started", item: { type: "command_execution" } });
} else if (input.includes("fixture-mcp")) {
  emit({
    type: "item.started",
    item: {
      type: "mcp_tool_call",
      server: input.includes("fixture-mcp-repair") ? "project" : "foreign",
    },
  });
} else if (input.includes("fixture-exit")) {
  process.stderr.write("PRIVATE_DIAGNOSTICS_MUST_NOT_LEAK");
  process.exitCode = 3;
} else if (input.includes("fixture-missing")) {
  emit({ type: "turn.completed", usage: {} });
} else if (input.includes("fixture-incomplete")) {
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: '{"text":"x","a2uiJson":"[]"}' },
  });
} else if (input.includes("fixture-limit")) {
  process.stdout.write("x".repeat(20000));
} else if (input.includes("fixture-stderr-limit")) {
  process.stderr.write("x".repeat(20000));
} else if (input.includes("fixture-config")) {
  const schema = JSON.parse(
    fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"),
  );
  complete(
    JSON.stringify({
      text: JSON.stringify({
        args,
        cwd: process.cwd(),
        tokenPresent: !!process.env.A2UI_RUN_TOKEN,
        privateEnvPresent: !!process.env.A2UI_PRIVATE_TEST,
        schema,
      }),
      a2uiJson: "[]",
    }),
  );
} else if (input.includes("fixture-invalid-output")) {
  complete('{"text":9,"a2uiJson":"[]"}');
} else {
  emit({ type: "thread.started", thread_id: "fixture" });
  complete(JSON.stringify({ text: "fixture result", a2uiJson: "[]" }));
}
