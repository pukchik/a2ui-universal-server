import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { envSchema } from "../server/config.ts";
import { Store } from "../server/storage/store.ts";
import {
  planRuntimeCleanup,
  purgeRuntime,
} from "../server/adapters/codex/runtime.ts";

if (process.argv.slice(2).some((arg) => arg !== "--apply"))
  throw new Error(
    "Используйте maintenance без аргументов для просмотра или --apply для очистки",
  );
const dryRun = !process.argv.includes("--apply");
const config = envSchema.parse(process.env);
const runtimeDays = z.coerce
  .number()
  .int()
  .min(0)
  .max(3650)
  .default(0)
  .parse(process.env.CODEX_RUNTIME_RETENTION_DAYS);
const runtime =
  runtimeDays > 0
    ? {
        retentionDays: runtimeDays,
        runtimeDir:
          process.env.CODEX_RUNTIME_DIR ?? join(tmpdir(), "a2ui-codex"),
        profileDir: z.string().min(1).parse(process.env.CODEX_PROFILE_DIR),
      }
    : undefined;
// Validate the filesystem plan before committing any database cleanup.
const planned = runtime ? await planRuntimeCleanup(runtime) : [];
const store = new Store(config.DATABASE_URL);
try {
  const database = await store.maintenance({
    dryRun,
    historyDays: config.HISTORY_RETENTION_DAYS,
    commandDays: config.COMMAND_RETENTION_DAYS,
  });
  const runtimePaths =
    runtime && !dryRun ? await purgeRuntime(runtime) : planned;
  console.log(
    JSON.stringify(
      { database, runtime: { dryRun, paths: runtimePaths } },
      null,
      2,
    ),
  );
} finally {
  await store.close();
}
