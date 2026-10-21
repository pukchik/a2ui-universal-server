CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS dialogs (
 id uuid PRIMARY KEY, user_id text NOT NULL, title text NOT NULL, seq integer NOT NULL DEFAULT 0,
 ui jsonb NOT NULL DEFAULT '{"messages":[],"revision":0}', latest_run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
 id uuid PRIMARY KEY, dialog_id uuid NOT NULL REFERENCES dialogs(id), status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
 generation uuid NOT NULL, input jsonb NOT NULL, error jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(dialog_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS commands (
 user_id text NOT NULL, id uuid NOT NULL, hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS dialog_events (
 dialog_id uuid NOT NULL REFERENCES dialogs(id), seq integer NOT NULL, type text NOT NULL, run_id uuid,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(dialog_id,seq)
);
CREATE TABLE IF NOT EXISTS messages (
 id bigserial PRIMARY KEY, dialog_id uuid NOT NULL REFERENCES dialogs(id), role text NOT NULL,
 text text NOT NULL, run_id uuid NOT NULL REFERENCES runs(id)
);
CREATE TABLE IF NOT EXISTS tool_calls (
 run_id uuid NOT NULL REFERENCES runs(id), id text NOT NULL, name text NOT NULL, args jsonb NOT NULL,
 status text NOT NULL, result jsonb, PRIMARY KEY(run_id,id)
);
CREATE TABLE IF NOT EXISTS sessions (
 hash text PRIMARY KEY, user_id text NOT NULL, display_name text NOT NULL, csrf text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
 hash text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz NOT NULL
);
INSERT INTO migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
