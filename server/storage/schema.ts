import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
// SQL migration owns constraints and locking queries; this schema serves typed reads.
export const dialogs = pgTable("dialogs", {
  mode: text().notNull(),
  id: uuid().primaryKey(),
  userId: text("user_id").notNull(),
  title: text().notNull(),
  seq: integer().notNull(),
  ui: jsonb().notNull(),
  latestRunId: uuid("latest_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
