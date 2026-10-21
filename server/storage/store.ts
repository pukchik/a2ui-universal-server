import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq, and } from "drizzle-orm";
import { dialogs } from "./schema.ts";
import { defaultCatalog } from "../../packages/catalogs/src/index.ts";
import type { CatalogSnapshot } from "../../packages/catalogs/src/index.ts";
import { AppError } from "../../packages/core/src/errors.ts";
import { applyUi, validateAction } from "../../packages/core/src/ui.ts";
import { catalogModel } from "../catalog-profile.ts";
import type { CatalogProfile } from "../catalog-profile.ts";
import { retentionSchema } from "../retention.ts";
import type { RetentionOptions } from "../retention.ts";
import type {
  Action,
  ChatMessage,
  Dialog,
  Event,
  Json,
  Run,
  UiState,
} from "../../packages/contracts/src/index.ts";
export type Session = {
  userId: string;
  name: string;
  csrf: string;
  expiresAt: Date;
};
type Client = pg.PoolClient;
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const runFrom = (row: Record<string, any>): Run => ({
  id: row.id,
  dialogId: row.dialog_id,
  status: row.status,
  generation: row.generation,
  input: row.input,
  ...(row.error ? { error: row.error } : {}),
});
export class Store {
  catalog?: CatalogSnapshot;
  catalogProfiles: readonly CatalogProfile[] = [];
  maxPendingRuns = 100;
  maxUserPendingRuns = 10;
  pool: pg.Pool;
  db: ReturnType<typeof drizzle>;
  lock?: Client;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 5000,
    });
    this.db = drizzle(this.pool);
  }
  async transaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    this.catalog ??= await defaultCatalog();
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(1760502045)");
      await c.query(
        await readFile(new URL("./0001.sql", import.meta.url), "utf8"),
      );
      await c.query(
        await readFile(new URL("./0002.sql", import.meta.url), "utf8"),
      );
      await c.query(
        await readFile(new URL("./0003.sql", import.meta.url), "utf8"),
      );
      await c.query(
        await readFile(new URL("./0004.sql", import.meta.url), "utf8"),
      );
    });
  }
  async acquireLock(onLost: () => void) {
    const c = await this.pool.connect();
    const { rows } = await c.query(
      "SELECT pg_try_advisory_lock(1760502046) AS acquired",
    );
    if (!rows[0].acquired) {
      c.release();
      throw new Error("Другой экземпляр сервера уже выполняет задания");
    }
    this.lock = c;
    c.on("error", onLost);
    await this.transaction(async (client) => {
      const interrupted = await client.query(
        "SELECT * FROM runs WHERE status='running'",
      );
      for (const row of interrupted.rows) {
        await client.query("SELECT id FROM dialogs WHERE id=$1 FOR UPDATE", [
          row.dialog_id,
        ]);
        const error = {
          code: "interrupted",
          message: "Выполнение прервано перезапуском сервера",
        };
        await client.query(
          "UPDATE runs SET status='failed',error=$2 WHERE id=$1",
          [row.id, error],
        );
        await this.event(client, row.dialog_id, "run.failed", error, row.id);
      }
      await client.query(
        "UPDATE tool_calls SET status='failed' WHERE status='running'",
      );
    });
  }
  async close() {
    if (this.lock) {
      await this.lock
        .query("SELECT pg_advisory_unlock(1760502046)")
        .catch(() => {});
      this.lock.release();
      this.lock = undefined;
    }
    await this.pool.end();
  }
  async maintenance(options: RetentionOptions = {}) {
    const policy = retentionSchema.parse(options);
    return this.transaction(async (c) => {
      const lock = await c.query(
        "SELECT pg_try_advisory_xact_lock(1760502048) AS acquired",
      );
      if (!lock.rows[0].acquired)
        return {
          dryRun: policy.dryRun,
          busy: true,
          dialogIds: [] as string[],
          dialogs: 0,
          commands: 0,
          sessions: 0,
          loginAttempts: 0,
        };
      const history =
        policy.historyDays > 0
          ? await c.query(
              "SELECT d.id FROM dialogs d WHERE d.updated_at < now()-$1::integer*interval '1 day' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.dialog_id=d.id AND r.status IN ('queued','running')) ORDER BY d.updated_at LIMIT $2 FOR UPDATE OF d SKIP LOCKED",
              [policy.historyDays, policy.batchSize],
            )
          : { rows: [] };
      const dialogIds: string[] = history.rows.map((row) => row.id);
      const commands =
        policy.commandDays > 0
          ? await c.query(
              "SELECT c.user_id,c.id FROM commands c WHERE c.created_at < now()-$1::integer*interval '1 day' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.status IN ('queued','running') AND (r.id::text=c.result->>'runId' OR r.dialog_id::text IN (c.result->>'dialogId',c.result->>'generationId'))) ORDER BY c.created_at LIMIT $2 FOR UPDATE OF c SKIP LOCKED",
              [policy.commandDays, policy.batchSize],
            )
          : { rows: [] };
      const sessions = await c.query(
        "SELECT hash FROM sessions WHERE expires_at<now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED",
        [policy.batchSize],
      );
      const attempts = await c.query(
        "SELECT hash FROM login_attempts WHERE expires_at<now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED",
        [policy.batchSize],
      );
      if (!policy.dryRun) {
        if (dialogIds.length) {
          // Keep deduplication tombstones so a retry cannot resurrect a purged job.
          await c.query(
            "UPDATE commands SET expired=true,result='{\"expired\":true}' WHERE COALESCE(result->>'dialogId',result->>'generationId')=ANY($1::text[]) OR result->>'runId' IN (SELECT id::text FROM runs WHERE dialog_id=ANY($1::uuid[]))",
            [dialogIds],
          );
          await c.query(
            "DELETE FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE dialog_id=ANY($1::uuid[]))",
            [dialogIds],
          );
          await c.query(
            "DELETE FROM messages WHERE dialog_id=ANY($1::uuid[])",
            [dialogIds],
          );
          await c.query(
            "DELETE FROM dialog_events WHERE dialog_id=ANY($1::uuid[])",
            [dialogIds],
          );
          await c.query("DELETE FROM runs WHERE dialog_id=ANY($1::uuid[])", [
            dialogIds,
          ]);
          await c.query("DELETE FROM dialogs WHERE id=ANY($1::uuid[])", [
            dialogIds,
          ]);
        }
        if (commands.rows.length)
          await c.query(
            "DELETE FROM commands c USING jsonb_to_recordset($1::jsonb) AS entry(user_id text,id uuid) WHERE c.user_id=entry.user_id AND c.id=entry.id",
            [JSON.stringify(commands.rows)],
          );
        await c.query("DELETE FROM sessions WHERE hash=ANY($1::text[])", [
          sessions.rows.map((row) => row.hash),
        ]);
        await c.query("DELETE FROM login_attempts WHERE hash=ANY($1::text[])", [
          attempts.rows.map((row) => row.hash),
        ]);
      }
      return {
        dryRun: policy.dryRun,
        busy: false,
        dialogIds,
        dialogs: dialogIds.length,
        commands: commands.rows.length,
        sessions: sessions.rows.length,
        loginAttempts: attempts.rows.length,
      };
    });
  }
  async list(userId: string) {
    return this.db
      .select({
        id: dialogs.id,
        title: dialogs.title,
        createdAt: dialogs.createdAt,
      })
      .from(dialogs)
      .where(and(eq(dialogs.userId, userId), eq(dialogs.mode, "dialog")))
      .orderBy(desc(dialogs.createdAt))
      .limit(100);
  }
  private async owned(
    c: Client | pg.Pool,
    id: string,
    userId: string,
    lock = false,
  ): Promise<Dialog> {
    const { rows } = await c.query(
      `SELECT * FROM dialogs WHERE id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`,
      [id, userId],
    );
    if (!rows[0]) throw new AppError(404, "not_found");
    const row = rows[0];
    const run = row.latest_run_id
      ? (await c.query("SELECT * FROM runs WHERE id=$1", [row.latest_run_id]))
          .rows[0]
      : null;
    return {
      taskState: row.task_state ?? {},
      mode: row.mode,
      catalog: row.catalog ?? this.catalog,
      id: row.id,
      userId: row.user_id,
      title: row.title,
      seq: row.seq,
      ui: row.ui,
      run: run ? runFrom(run) : null,
      createdAt: row.created_at.toISOString(),
    };
  }
  async get(id: string, userId: string) {
    return this.owned(this.pool, id, userId);
  }
  async snapshot(id: string, userId: string) {
    return this.transaction(async (c) => {
      const dialog = await this.owned(c, id, userId, true);
      const { rows } = await c.query(
        "SELECT m.*, r.status FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.dialog_id=$1 ORDER BY m.id",
        [id],
      );
      const messages: ChatMessage[] = rows.map((r) => ({
        role: r.role,
        text: r.text,
        runId: r.run_id,
        incomplete: r.status === "failed" || r.status === "cancelled",
      }));
      return { dialog, messages, throughSeq: dialog.seq };
    });
  }
  private async event(
    c: Client,
    id: string,
    type: string,
    payload: unknown,
    runId?: string,
  ) {
    const { rows } = await c.query(
      "UPDATE dialogs SET seq=seq+1,updated_at=now() WHERE id=$1 RETURNING seq",
      [id],
    );
    await c.query(
      "INSERT INTO dialog_events(dialog_id,seq,type,payload,run_id) VALUES($1,$2,$3,$4,$5)",
      [id, rows[0].seq, type, JSON.stringify(payload), runId ?? null],
    );
  }
  async events(id: string, userId: string, after: number): Promise<Event[]> {
    const dialog = await this.get(id, userId);
    if (after > dialog.seq) throw new AppError(422, "invalid_cursor");
    const { rows } = await this.pool.query(
      "SELECT * FROM dialog_events WHERE dialog_id=$1 AND seq>$2 ORDER BY seq LIMIT 100",
      [id, after],
    );
    return rows.map((r) => ({
      dialogId: id,
      seq: r.seq,
      type: r.type,
      runId: r.run_id ?? undefined,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
    }));
  }
  private async replay(
    c: Client,
    userId: string,
    id: string,
    fingerprint: string,
  ) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `commands:${userId}`,
    ]);
    const { rows } = await c.query(
      "SELECT * FROM commands WHERE user_id=$1 AND id=$2",
      [userId, id],
    );
    if (rows[0] && rows[0].hash !== fingerprint)
      throw new AppError(409, "command_conflict");
    if (rows[0]?.expired)
      throw new AppError(
        410,
        "command_expired",
        "Результат этой команды удалён по сроку хранения.",
      );
    return rows[0]?.result;
  }
  private async record(
    c: Client,
    userId: string,
    id: string,
    fingerprint: string,
    result: unknown,
  ) {
    await c.query(
      "INSERT INTO commands(user_id,id,hash,result) VALUES($1,$2,$3,$4)",
      [userId, id, fingerprint, JSON.stringify(result)],
    );
    return result;
  }
  private async queueCapacity(c: Client, userId: string) {
    // Both admission routes and all users share this database-wide critical section.
    await c.query("SELECT pg_advisory_xact_lock(1760502047)");
    const { rows } = await c.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE d.user_id=$1)::int AS owned FROM runs r JOIN dialogs d ON d.id=r.dialog_id WHERE r.status IN ('queued','running')",
      [userId],
    );
    if (rows[0].owned >= this.maxUserPendingRuns)
      throw new AppError(429, "queue_limit");
    if (rows[0].total >= this.maxPendingRuns)
      throw new AppError(
        429,
        "global_queue_limit",
        "Сервер занят. Повторите запрос позже.",
      );
  }
  async create(userId: string, commandId: string) {
    return this.transaction(async (c) => {
      const fingerprint = hash(["create"]);
      const replay = await this.replay(c, userId, commandId, fingerprint);
      if (replay) {
        await this.owned(c, replay.dialogId, userId);
        return replay;
      }
      const id = randomUUID();
      await c.query(
        "INSERT INTO dialogs(id,user_id,title,catalog) VALUES($1,$2,$3,$4)",
        [id, userId, "Новый диалог", JSON.stringify(this.catalog)],
      );
      return this.record(c, userId, commandId, fingerprint, {
        commandId,
        dialogId: id,
      });
    });
  }
  async accept(
    userId: string,
    id: string,
    commandId: string,
    input: Run["input"],
    revision?: number,
  ) {
    return this.transaction(async (c) => {
      const fingerprint = hash([id, input, revision ?? null]);
      const replay = await this.replay(c, userId, commandId, fingerprint);
      const dialog = await this.owned(c, id, userId, true);
      if (replay) return replay;
      if (dialog.mode === "generation")
        throw new AppError(409, "generation_is_one_shot");
      if (dialog.run && ["queued", "running"].includes(dialog.run.status))
        throw new AppError(409, "dialog_busy");
      if (input.action) {
        if (dialog.run?.status !== "succeeded")
          throw new AppError(409, "ui_inactive");
        validateAction(dialog.ui, revision ?? -1, input.action);
      }
      await this.queueCapacity(c, userId);
      const runId = randomUUID();
      await c.query(
        "INSERT INTO runs(id,dialog_id,status,generation,input) VALUES($1,$2,'queued',$3,$4)",
        [runId, id, randomUUID(), input],
      );
      await c.query(
        "UPDATE dialogs SET latest_run_id=$2,title=CASE WHEN latest_run_id IS NULL THEN $3 ELSE title END WHERE id=$1",
        [id, runId, (input.text ?? "Действие интерфейса").slice(0, 80)],
      );
      await c.query(
        "INSERT INTO messages(dialog_id,role,text,run_id) VALUES($1,$2,$3,$4)",
        [id, "user", input.text ?? `Действие: ${input.action!.name}`, runId],
      );
      await this.event(c, id, "run.queued", { runId }, runId);
      return this.record(c, userId, commandId, fingerprint, {
        commandId,
        dialogId: id,
        runId,
      });
    });
  }
  async generate(userId: string, commandId: string, text: string) {
    return this.transaction(async (c) => {
      const fingerprint = hash(["generate", text]);
      const replay = await this.replay(c, userId, commandId, fingerprint);
      if (replay) {
        await this.owned(c, replay.generationId, userId);
        return replay;
      }
      await this.queueCapacity(c, userId);
      const id = randomUUID(),
        runId = randomUUID();
      await c.query(
        "INSERT INTO dialogs(id,user_id,title,mode,catalog) VALUES($1,$2,$3,'generation',$4)",
        [id, userId, text.slice(0, 80), JSON.stringify(this.catalog)],
      );
      await c.query(
        "INSERT INTO runs(id,dialog_id,status,generation,input) VALUES($1,$2,'queued',$3,$4)",
        [runId, id, randomUUID(), { text }],
      );
      await c.query("UPDATE dialogs SET latest_run_id=$2 WHERE id=$1", [
        id,
        runId,
      ]);
      await c.query(
        "INSERT INTO messages(dialog_id,role,text,run_id) VALUES($1,$2,$3,$4)",
        [id, "user", text, runId],
      );
      await this.event(c, id, "run.queued", { runId }, runId);
      return this.record(c, userId, commandId, fingerprint, {
        commandId,
        generationId: id,
        runId,
      });
    });
  }
  async claim(): Promise<Run | undefined> {
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        "SELECT r.* FROM runs r JOIN dialogs d ON d.id=r.dialog_id WHERE r.status='queued' ORDER BY r.created_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED",
      );
      if (!rows[0]) return;
      const row = rows[0];
      await c.query("SELECT id FROM dialogs WHERE id=$1 FOR UPDATE", [
        row.dialog_id,
      ]);
      const generation = randomUUID();
      await c.query(
        "UPDATE runs SET status='running',generation=$2 WHERE id=$1",
        [row.id, generation],
      );
      await this.event(
        c,
        row.dialog_id,
        "run.running",
        { runId: row.id },
        row.id,
      );
      return runFrom({ ...row, status: "running", generation });
    });
  }
  async active(c: Client | pg.Pool, run: Run) {
    const { rows } = await c.query(
      "SELECT id FROM runs WHERE id=$1 AND generation=$2 AND status='running'",
      [run.id, run.generation],
    );
    if (!rows[0]) throw new AppError(409, "run_inactive");
  }
  async runOwner(run: Run): Promise<string> {
    const { rows } = await this.pool.query(
      "SELECT d.user_id FROM runs r JOIN dialogs d ON d.id=r.dialog_id WHERE r.id=$1 AND r.dialog_id=$2 AND r.generation=$3 AND r.status='running'",
      [run.id, run.dialogId, run.generation],
    );
    if (!rows[0]) throw new AppError(409, "run_inactive");
    return rows[0].user_id;
  }
  async complete(run: Run, text: string, messages: unknown) {
    return this.transaction(async (c) => {
      await c.query("SELECT id FROM dialogs WHERE id=$1 FOR UPDATE", [
        run.dialogId,
      ]);
      await this.active(c, run);
      const row = (
        await c.query("SELECT ui,catalog FROM dialogs WHERE id=$1", [
          run.dialogId,
        ])
      ).rows[0];
      const snapshot = row.catalog ?? this.catalog!;
      const ui = applyUi(
        row.ui,
        messages,
        snapshot.document,
        catalogModel(snapshot, this.catalogProfiles),
      );
      await c.query("UPDATE dialogs SET ui=$2 WHERE id=$1", [run.dialogId, ui]);
      if (ui.revision !== row.ui.revision)
        await this.event(c, run.dialogId, "ui.updated", { ui }, run.id);
      if (text) {
        await c.query(
          "INSERT INTO messages(dialog_id,role,text,run_id) VALUES($1,$2,$3,$4)",
          [run.dialogId, "assistant", text, run.id],
        );
        await this.event(c, run.dialogId, "message.text", { text }, run.id);
      }
      await c.query("UPDATE runs SET status='succeeded' WHERE id=$1", [run.id]);
      await this.event(
        c,
        run.dialogId,
        "run.succeeded",
        { runId: run.id },
        run.id,
      );
    });
  }
  async fail(run: Run, code: string, message: string) {
    return this.transaction(async (c) => {
      await c.query("SELECT id FROM dialogs WHERE id=$1 FOR UPDATE", [
        run.dialogId,
      ]);
      const result = await c.query(
        "UPDATE runs SET status='failed',error=$3 WHERE id=$1 AND generation=$2 AND status='running' RETURNING id",
        [run.id, run.generation, { code, message }],
      );
      if (result.rowCount) {
        await c.query(
          "UPDATE tool_calls SET status='failed' WHERE run_id=$1 AND status='running'",
          [run.id],
        );
        await this.event(
          c,
          run.dialogId,
          "run.failed",
          { code, message },
          run.id,
        );
      }
    });
  }
  async cancel(userId: string, id: string, runId: string, commandId: string) {
    return this.transaction(async (c) => {
      const fingerprint = hash(["cancel", id, runId]);
      const replay = await this.replay(c, userId, commandId, fingerprint);
      await this.owned(c, id, userId, true);
      if (replay) return replay;
      const { rows } = await c.query(
        "SELECT * FROM runs WHERE id=$1 AND dialog_id=$2",
        [runId, id],
      );
      if (!rows[0]) throw new AppError(404, "not_found");
      let status = rows[0].status;
      if (["queued", "running"].includes(status)) {
        status = "cancelled";
        await c.query("UPDATE runs SET status='cancelled' WHERE id=$1", [
          runId,
        ]);
        await c.query(
          "UPDATE tool_calls SET status='cancelled' WHERE run_id=$1 AND status='running'",
          [runId],
        );
        await this.event(c, id, "run.cancelled", { runId }, runId);
      }
      return this.record(c, userId, commandId, fingerprint, {
        commandId,
        runId,
        status,
      });
    });
  }
  async toolStart(
    run: Run,
    id: string,
    name: string,
    args: unknown,
  ): Promise<{ cached: boolean; result?: Json }> {
    return this.transaction(async (c) => {
      await c.query("SELECT id FROM dialogs WHERE id=$1 FOR UPDATE", [
        run.dialogId,
      ]);
      await this.active(c, run);
      const { rows } = await c.query(
        "SELECT * FROM tool_calls WHERE run_id=$1 AND id=$2",
        [run.id, id],
      );
      const row = rows[0];
      if (row) {
        if (row.name !== name || hash(row.args) !== hash(args))
          throw new AppError(409, "tool_conflict");
        if (row.status !== "succeeded")
          throw new AppError(409, "tool_unavailable");
        return { cached: true, result: row.result };
      }
      const count = await c.query(
        "SELECT count(*)::int AS n FROM tool_calls WHERE run_id=$1",
        [run.id],
      );
      if (count.rows[0].n >= 12) throw new AppError(429, "tool_limit");
      await c.query(
        "INSERT INTO tool_calls(run_id,id,name,args,status) VALUES($1,$2,$3,$4,'running')",
        [run.id, id, name, JSON.stringify(args)],
      );
      return { cached: false };
    });
  }
  async toolEnd(run: Run, id: string, result: Json, failed = false) {
    return this.transaction(async (c) => {
      await c.query("SELECT id FROM dialogs WHERE id=$1 FOR UPDATE", [
        run.dialogId,
      ]);
      await this.active(c, run);
      await c.query(
        "UPDATE tool_calls SET status=$3,result=$4 WHERE run_id=$1 AND id=$2",
        [run.id, id, failed ? "failed" : "succeeded", JSON.stringify(result)],
      );
    });
  }
  async putSession(hash: string, session: Session) {
    await this.pool.query("INSERT INTO sessions VALUES($1,$2,$3,$4,$5)", [
      hash,
      session.userId,
      session.name,
      session.csrf,
      session.expiresAt,
    ]);
  }
  async session(hash: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM sessions WHERE hash=$1 AND expires_at>now()",
      [hash],
    );
    const r = rows[0];
    return r
      ? {
          userId: r.user_id,
          name: r.display_name,
          csrf: r.csrf,
          expiresAt: r.expires_at,
        }
      : undefined;
  }
  async revokeSession(hash: string) {
    await this.pool.query(
      "UPDATE sessions SET expires_at=now() WHERE hash=$1",
      [hash],
    );
  }
  async loginAttempt(hash: string, value?: unknown) {
    if (value) {
      await this.pool.query(
        "INSERT INTO login_attempts VALUES($1,$2,now()+interval '10 minutes')",
        [hash, JSON.stringify(value)],
      );
      return;
    }
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        "SELECT value FROM login_attempts WHERE hash=$1 AND expires_at>now() FOR UPDATE",
        [hash],
      );
      await c.query(
        "UPDATE login_attempts SET expires_at=now() WHERE hash=$1",
        [hash],
      );
      return rows[0]?.value;
    });
  }
}
