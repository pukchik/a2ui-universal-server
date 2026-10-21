import { configFrom } from "../../apps/server/src/config.ts";
import { buildDemoApp as buildApp } from "./app.ts";
const config = configFrom(process.env);
const { app, store, engine } = await buildApp(config, {
  logger: true,
  startEngine: false,
});
await store.migrate();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await engine.stop();
  await app.close();
  await store.close();
}
await store.acquireLock(() => {
  app.log.fatal("Потеряна блокировка исполнения PostgreSQL");
  void shutdown().finally(() => process.exit(1));
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
  engine.start();
} catch (error) {
  await shutdown();
  throw error;
}
for (const name of ["SIGTERM", "SIGINT"] as const)
  process.once(name, () => void shutdown());
