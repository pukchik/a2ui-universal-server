ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE commands ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE commands ADD COLUMN IF NOT EXISTS expired boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS dialogs_retention ON dialogs(updated_at);
CREATE INDEX IF NOT EXISTS commands_retention ON commands(created_at);
CREATE INDEX IF NOT EXISTS pending_runs ON runs(dialog_id) WHERE status IN ('queued','running');
INSERT INTO migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
