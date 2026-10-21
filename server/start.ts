import { buildApp } from "./app.ts";
import type { AppOptions } from "./app.ts";
import type { Config } from "./config.ts";
import { Store } from "./storage/store.ts";

export type StartOptions = Omit<AppOptions, "startEngine"> & {
  handleSignals?: boolean;
  onLockLost?: () => void;
};

export async function startServer(config: Config, options: StartOptions) {
  const store = options.store ?? new Store(config.DATABASE_URL);
  let built: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closing: Promise<void> | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let maintenanceTask: Promise<unknown> | undefined;
  const signal = () => {
    void close()
      .catch((error) => {
        console.error(
          "shutdown:",
          error instanceof Error ? error.message : "error",
        );
        process.exitCode = 1;
      })
      .then(() => {
        // A handler that ignored abort may leave timers or sockets behind.
        // Embedded applications own process termination via handleSignals:false.
        if (options.handleSignals !== false)
          process.exit(process.exitCode ?? 0);
      });
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGTERM", signal);
      clearInterval(maintenanceTimer);
      try {
        await built?.app.close();
      } finally {
        await maintenanceTask;
        await store.close();
      }
    })());
  try {
    built = await buildApp(config, { ...options, store, startEngine: false });
    await store.migrate();
    await store.acquireLock(() => {
      built!.app.log.fatal("Потеряна блокировка исполнения PostgreSQL");
      if (options.handleSignals !== false) process.exitCode = 1;
      signal();
      options.onLockLost?.();
    });
    if (closing) throw new Error("Сервер остановлен во время запуска");
    await built.app.listen({ host: config.HOST, port: config.PORT });
    if (closing) throw new Error("Сервер остановлен во время запуска");
    const address = built.app.server.address();
    if (address && typeof address !== "string")
      built.engine.url = `http://127.0.0.1:${address.port}/internal/mcp`;
    if (options.handleSignals !== false) {
      process.once("SIGINT", signal);
      process.once("SIGTERM", signal);
    }
    built.engine.start();
    if (config.MAINTENANCE_INTERVAL_MS > 0) {
      maintenanceTimer = setInterval(() => {
        if (closing || maintenanceTask) return;
        maintenanceTask = store
          .maintenance({
            historyDays: config.HISTORY_RETENTION_DAYS,
            commandDays: config.COMMAND_RETENTION_DAYS,
            dryRun: false,
          })
          .catch(() => built!.app.log.error("Maintenance failed"))
          .finally(() => {
            maintenanceTask = undefined;
          });
      }, config.MAINTENANCE_INTERVAL_MS);
      maintenanceTimer.unref();
    }
    return { ...built, close };
  } catch (error) {
    await close();
    throw error;
  }
}
