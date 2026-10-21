import { spawn } from "node:child_process";
import { mkdtemp, mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// Disposable demo only: one backend container, private PostgreSQL over a Unix socket.
const pgBin = process.env.PG_BIN ?? "/usr/lib/postgresql/18/bin";
let database;
let server;
let stopping;
let requestedStop = false;
const closed = (child) =>
  new Promise((resolve) => child.once("close", resolve));
async function command(name, args) {
  const child = spawn(join(pgBin, name), args, { stdio: "inherit" });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (result !== 0) throw new Error(`${name} failed: ${result}`);
}
function stop() {
  return (stopping ??= (async () => {
    const timer = setTimeout(() => {
      server?.kill("SIGKILL");
      database?.kill("SIGKILL");
    }, 5000);
    if (server && server.exitCode === null && server.signalCode === null) {
      const done = closed(server);
      server.kill("SIGTERM");
      await done;
    }
    if (
      database &&
      database.exitCode === null &&
      database.signalCode === null
    ) {
      const done = closed(database);
      database.kill("SIGTERM");
      await done;
    }
    clearTimeout(timer);
  })());
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    requestedStop = true;
    void stop();
  });
try {
  const runtime = await mkdtemp("/tmp/a2ui-demo-");
  const data = join(runtime, "data");
  const socket = join(runtime, "socket");
  await mkdir(socket);
  await command("initdb", [
    "-D",
    data,
    "--username=a2ui_demo",
    "--encoding=UTF8",
    "--no-locale",
    "--auth-local=trust",
    "--auth-host=reject",
    "--wal-segsize=1",
  ]);
  await appendFile(
    join(data, "postgresql.conf"),
    `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nshared_buffers = '16MB'\nmax_connections = 20\nwal_level = minimal\nmax_wal_senders = 0\nmax_wal_size = '8MB'\nmin_wal_size = '2MB'\nfsync = off\nfull_page_writes = off\nsynchronous_commit = off\n`,
  );
  if (requestedStop) throw new Error("Demo stopped during startup");
  database = spawn(join(pgBin, "postgres"), ["-D", data], { stdio: "inherit" });
  const databaseDone = new Promise((resolve, reject) => {
    database.once("error", reject);
    database.once("close", resolve);
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      database.exitCode !== null ||
      database.signalCode !== null ||
      requestedStop
    )
      break;
    const child = spawn(
      join(pgBin, "pg_isready"),
      ["-h", socket, "-U", "a2ui_demo", "-d", "postgres"],
      { stdio: "ignore" },
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Demo database did not become ready");
  await command("createdb", ["-h", socket, "-U", "a2ui_demo", "a2ui_demo"]);
  const revision = (
    await readFile(new URL("../REVISION", import.meta.url), "utf8")
  ).trim();
  server = spawn(process.execPath, ["apps/server/src/main.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://a2ui_demo@localhost/a2ui_demo?host=${socket}`,
      AUTH_MODE: "demo",
      PUBLIC_DEMO: "true",
      ADAPTER: "fixture",
      APP_REVISION: revision,
    },
  });
  const serverDone = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("close", resolve);
  });
  const outcome = await Promise.race([
    serverDone.then((code) => ({ kind: "server", code })),
    databaseDone.then((code) => ({ kind: "database", code })),
  ]);
  await stop();
  if (!requestedStop && (outcome.kind === "database" || outcome.code !== 0))
    throw new Error(`Demo ${outcome.kind} exited: ${outcome.code}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo startup failed");
  await stop();
  process.exitCode = requestedStop ? 0 : 1;
}
