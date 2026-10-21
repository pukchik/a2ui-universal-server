import { fileURLToPath } from "node:url";
import { buildApp } from "../../server/app.ts";
import type { Config } from "../../server/config.ts";
import { codexAdapter } from "../../server/adapters/codex.ts";
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
  return buildApp(config, {
    ...options,
    adapter:
      config.ADAPTER === "fixture"
        ? fixtureAdapter
        : codexAdapter({
            executable: config.CODEX_BIN,
            profileDir: config.CODEX_PROFILE_DIR!,
            model: config.CODEX_MODEL,
          }),
    tools: toolDefinitions,
    instructions,
    webRoot: fileURLToPath(new URL("../web/dist/", import.meta.url)),
  });
}
