import { buildApp, configFrom } from "../server/index.ts";

// Schema generation needs neither a database connection nor an agent process.
const { app, store } = await buildApp(
  configFrom({ DATABASE_URL: "postgres://unused/unused", AUTH_MODE: "demo" }),
  {
    startEngine: false,
    adapter: {
      kind: "agent",
      async run() {
        throw new Error("Schema export never runs an agent");
      },
    },
  },
);
try {
  await app.ready();
  process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
} finally {
  await app.close();
  await store.close();
}
