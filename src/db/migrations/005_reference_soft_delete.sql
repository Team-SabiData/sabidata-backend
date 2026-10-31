-- Phase 6 — soft-delete du référentiel (langues via status, dialectes via active).

ALTER TABLE dialects ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_dialects_language ON dialects(language_id);
CREATE INDEX IF NOT EXISTS idx_dialects_active ON dialects(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_prompts_language ON prompts(language_id);
CREATE INDEX IF NOT EXISTS idx_prompts_dialect ON prompts(dialect_id);
