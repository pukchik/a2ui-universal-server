import { fileURLToPath } from "node:url";
import { buildApp } from "../../server/app.ts";
import type { Config } from "./config.ts";
import { codexAdapter } from "../../server/adapters/codex/index.ts";
import { fixtureAdapter } from "./fixture.ts";
import { toolDefinitions } from "./tools.ts";
import { instructions } from "./instructions.ts";

export function buildDemoApp(
  config: Config,
  options: Pick<
    Parameters<typeof buildApp>[1],
    "store" | "logger" | "startEngine"
  > = {},
) {
  return buildApp(config, { ...demoOptions(config), ...options });
}

export function demoOptions(config: Config) {
  return {
    adapterName: config.ADAPTER,
    adapter:
      config.ADAPTER === "fixture"
        ? fixtureAdapter
        : codexAdapter(config.codex!),
    tools: toolDefinitions,
    instructions,
    webRoot: fileURLToPath(new URL("../web/dist/", import.meta.url)),
  };
}
