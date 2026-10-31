-- Phase 4 — accusés de lecture et pagination du chat support.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_last_read_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS staff_last_read_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_role
  ON chat_messages(conversation_id, sender_role, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_clip
  ON conversations(clip_id) WHERE clip_id IS NOT NULL;
