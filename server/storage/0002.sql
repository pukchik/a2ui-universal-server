ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'dialog' CHECK (mode IN ('dialog','generation'));
ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS catalog jsonb;
INSERT INTO migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
