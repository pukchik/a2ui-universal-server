import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../server/storage/store.ts";
import { configFrom, startServer } from "../server/index.ts";

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("retention and queue capacity on PostgreSQL", () => {
  const store = new Store(database!);
  const user = `retention-${randomUUID()}`;
  beforeAll(() => store.migrate());
  afterAll(() => store.close());
  const create = async (owner = user, commandId = randomUUID()) =>
    ((await store.create(owner, commandId)) as { dialogId: string }).dialogId;
  const age = async (ids: string[]) =>
    store.pool.query(
      "UPDATE dialogs SET updated_at=now()-interval '31 days' WHERE id=ANY($1::uuid[])",
      [ids],
    );
  it("previews cleanup, purges inactive history and keeps idempotency tombstones", async () => {
    const commandId = randomUUID();
    const id = await create(user, commandId);
    await store.accept(user, id, randomUUID(), { text: "private input" });
    const run = (await store.claim())!;
    await store.toolStart(run, "read", "read", {});
    await store.toolEnd(run, "read", { private: true });
    await store.complete(run, "private answer", []);
    await age([id]);
    const plan = await store.maintenance({ historyDays: 30, commandDays: 60 });
    expect(plan.dryRun).toBe(true);
    expect(plan.dialogIds).toContain(id);
    expect((await store.snapshot(id, user)).messages).toHaveLength(2);
    const applied = await store.maintenance({
      historyDays: 30,
      commandDays: 60,
      dryRun: false,
    });
    expect(applied.dialogIds).toContain(id);
    await expect(store.get(id, user)).rejects.toMatchObject({ status: 404 });
    for (const table of ["messages", "dialog_events", "runs"])
      expect(
        (
          await store.pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE dialog_id=$1`,
            [id],
          )
        ).rows[0].n,
      ).toBe(0);
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM tool_calls WHERE run_id=$1",
          [run.id],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(store.create(user, commandId)).rejects.toMatchObject({
      code: "command_expired",
    });
    expect(
      (
        await store.pool.query(
          "SELECT result FROM commands WHERE user_id=$1 AND id=$2",
          [user, commandId],
        )
      ).rows[0].result,
    ).toEqual({ expired: true });
  });
  it("protects queued and running dialogs even when their timestamps are old", async () => {
    const id = await create();
    const accepted = (await store.accept(user, id, randomUUID(), {
      text: "waiting",
    })) as { runId: string };
    await store.pool.query(
      "UPDATE commands SET created_at=now()-interval '61 days' WHERE result->>'runId'=$1",
      [accepted.runId],
    );
    await age([id]);
    expect(
      (
        await store.maintenance({
          historyDays: 30,
          commandDays: 60,
          dryRun: false,
        })
      ).dialogIds,
    ).not.toContain(id);
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM commands WHERE result->>'runId'=$1",
          [accepted.runId],
        )
      ).rows[0].n,
    ).toBe(1);
    const run = (await store.claim())!;
    await age([id]);
    expect(
      (await store.maintenance({ historyDays: 30, dryRun: false })).dialogIds,
    ).not.toContain(id);
    expect((await store.get(id, user)).run!.id).toBe(accepted.runId);
    await store.fail(run, "test", "Done");
  });
  it("bounds batches and returns busy instead of competing with another maintenance transaction", async () => {
    const ids = await Promise.all([create(), create()]);
    await age(ids);
    expect(
      (
        await store.maintenance({
          historyDays: 30,
          batchSize: 1,
          dryRun: false,
        })
      ).dialogs,
    ).toBe(1);
    const client = await store.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1760502048)");
      expect(
        (await store.maintenance({ historyDays: 30, dryRun: false })).busy,
      ).toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(
      (await store.maintenance({ historyDays: 30, dryRun: false })).dialogs,
    ).toBe(1);
  });
  it("expires old ledger entries and expired auth data without touching live sessions", async () => {
    const commandId = randomUUID();
    const id = await create(user, commandId);
    await store.pool.query(
      "UPDATE commands SET created_at=now()-interval '61 days' WHERE user_id=$1 AND id=$2",
      [user, commandId],
    );
    const expired = randomUUID(),
      live = randomUUID(),
      attempt = randomUUID();
    await store.putSession(expired, {
      userId: user,
      name: "Old",
      csrf: "old",
      expiresAt: new Date(0),
    });
    await store.putSession(live, {
      userId: user,
      name: "Live",
      csrf: "live",
      expiresAt: new Date(Date.now() + 60000),
    });
    await store.loginAttempt(attempt, { value: "old" });
    await store.pool.query(
      "UPDATE login_attempts SET expires_at=now()-interval '1 day' WHERE hash=$1",
      [attempt],
    );
    await store.maintenance({ commandDays: 60, dryRun: false });
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM commands WHERE user_id=$1 AND id=$2",
          [user, commandId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await store.get(id, user)).id).toBe(id);
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE hash=$1",
          [expired],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await store.session(live)).toBeDefined();
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM login_attempts WHERE hash=$1",
          [attempt],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("serializes global admission across users and both message/generation routes", async () => {
    store.maxPendingRuns = 3;
    const inputs = await Promise.all(
      Array.from({ length: 12 }, async (_value, index) => {
        const owner = `quota-${randomUUID()}`;
        return {
          owner,
          commandId: randomUUID(),
          dialogId: index % 2 ? undefined : await create(owner),
        };
      }),
    );
    const admit = (input: (typeof inputs)[number]) =>
      input.dialogId
        ? store.accept(input.owner, input.dialogId, input.commandId, {
            text: "work",
          })
        : store.generate(input.owner, input.commandId, "work");
    const results = await Promise.allSettled(inputs.map(admit));
    const accepted = results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? [
            {
              input: inputs[index],
              result: result.value as {
                dialogId?: string;
                generationId?: string;
                runId: string;
              },
            },
          ]
        : [],
    );
    expect(accepted).toHaveLength(3);
    const rejected = results.findIndex(
      (result) => result.status === "rejected",
    );
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason.code).toBe("global_queue_limit");
    expect(await admit(accepted[0].input)).toEqual(accepted[0].result); // replay bypasses capacity
    await store.claim(); // running jobs still occupy a slot
    await expect(admit(inputs[rejected])).rejects.toMatchObject({
      code: "global_queue_limit",
    });
    const first = accepted[0];
    await store.cancel(
      first.input.owner,
      first.result.dialogId ?? first.result.generationId!,
      first.result.runId,
      randomUUID(),
    );
    const retry = (await admit(inputs[rejected])) as typeof first.result;
    for (const entry of [
      ...accepted,
      { input: inputs[rejected], result: retry },
    ])
      await store.cancel(
        entry.input.owner,
        entry.result.dialogId ?? entry.result.generationId!,
        entry.result.runId,
        randomUUID(),
      );
    store.maxPendingRuns = 100;
  });
  it("enforces the configurable per-user limit independently", async () => {
    store.maxUserPendingRuns = 2;
    const ids = await Promise.all([create(), create(), create()]);
    const results = await Promise.allSettled(
      ids.map((id) => store.accept(user, id, randomUUID(), { text: "work" })),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected")
        expect(result.reason.code).toBe("queue_limit");
      else
        await store.cancel(
          user,
          ids[index],
          (result.value as { runId: string }).runId,
          randomUUID(),
        );
    }
    store.maxUserPendingRuns = 10;
  });
  it("runs opt-in periodic maintenance and stops it with the server", async () => {
    const id = await create();
    await age([id]);
    const config = configFrom({
      DATABASE_URL: database,
      AUTH_MODE: "demo",
      HISTORY_RETENTION_DAYS: "30",
      MAINTENANCE_INTERVAL_MS: "1000",
    });
    config.PORT = 0;
    const server = await startServer(config, {
      handleSignals: false,
      adapter: {
        kind: "agent",
        async run() {
          return { text: "", a2uiJson: "[]" };
        },
      },
    });
    try {
      await expect
        .poll(
          async () =>
            (
              await store.pool.query(
                "SELECT count(*)::int AS n FROM dialogs WHERE id=$1",
                [id],
              )
            ).rows[0].n,
          { timeout: 5000 },
        )
        .toBe(0);
    } finally {
      await server.close();
    }
    // A later interval must not issue queries after Store.close.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(server.app.server.listening).toBe(false);
  });
});

it("disables retention by default and rejects invalid retention horizons", () => {
  const env = { DATABASE_URL: "postgres://unused", AUTH_MODE: "custom" };
  expect(configFrom(env)).toMatchObject({
    HISTORY_RETENTION_DAYS: 0,
    COMMAND_RETENTION_DAYS: 0,
    MAINTENANCE_INTERVAL_MS: 0,
  });
  expect(() =>
    configFrom({
      ...env,
      HISTORY_RETENTION_DAYS: "30",
      COMMAND_RETENTION_DAYS: "10",
    }),
  ).toThrow();
});
