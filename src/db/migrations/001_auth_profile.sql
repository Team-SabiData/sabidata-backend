-- Phase 1 — révocation de session + changements de contact vérifiés par OTP.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS contact_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email    text,
  new_phone    text,
  verify_phone text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (new_email IS NOT NULL OR new_phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_contact_changes_user ON contact_changes(user_id);
