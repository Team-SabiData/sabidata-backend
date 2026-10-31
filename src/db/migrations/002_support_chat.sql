-- Phase 3 — chat support (polling REST, pièces jointes interdites).
-- Une seule conversation ouverte par utilisateur.

CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clip_id         uuid REFERENCES clips(id),
  subject         text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  last_message_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_open
  ON conversations(user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_conversations_status
  ON conversations(status, last_message_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id),
  sender_role     text NOT NULL CHECK (sender_role IN ('user','staff')),
  body            text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages(conversation_id, created_at);
