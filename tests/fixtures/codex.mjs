import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (input.includes("fixture-hang")) {
  console.log(JSON.stringify({ type: "turn.started" }));
  setInterval(() => {}, 1000);
} else if (input.includes("fixture-jsonl")) {
  console.log("invalid-jsonl");
} else if (input.includes("fixture-tool")) {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution" },
    }),
  );
} else if (input.includes("fixture-exit")) {
  process.exitCode = 3;
} else if (input.includes("fixture-missing")) {
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  fs.writeFileSync(
    output,
    JSON.stringify({ text: "fixture result", a2uiJson: "[]" }),
  );
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
}
