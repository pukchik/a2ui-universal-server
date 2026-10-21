import { z } from "zod";
import { configFrom as coreConfigFrom } from "../../server/config.ts";
import { codexOptionsFrom } from "../../server/adapters/codex/index.ts";

export function configFrom(env: NodeJS.ProcessEnv) {
  const core = coreConfigFrom(env);
  const ADAPTER = z
    .enum(["codex", "fixture"])
    .default("codex")
    .parse(env.ADAPTER);
  const codex = ADAPTER === "codex" ? codexOptionsFrom(env) : undefined;
  return { ...core, ADAPTER, codex };
}
export type Config = ReturnType<typeof configFrom>;
