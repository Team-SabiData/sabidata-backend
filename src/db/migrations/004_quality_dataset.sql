-- Phase 5 — qualité (rejet x2, soft-delete/purge) + statuts transcriptions.

ALTER TABLE clips ADD COLUMN IF NOT EXISTS rejection_count integer NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS rejection_count integer NOT NULL DEFAULT 0;
ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clips_rejection_count_check') THEN
    ALTER TABLE clips ADD CONSTRAINT clips_rejection_count_check CHECK (rejection_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transcriptions_rejection_count_check') THEN
    ALTER TABLE transcriptions
      ADD CONSTRAINT transcriptions_rejection_count_check CHECK (rejection_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transcriptions_status_check') THEN
    ALTER TABLE transcriptions
      ADD CONSTRAINT transcriptions_status_check
      CHECK (status IN ('pending','validated','rejected','deleted'));
  END IF;
END $$;

-- Les transcriptions déjà notées restent éligibles au dataset.
UPDATE transcriptions SET status = 'validated' WHERE tier IS NOT NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_clips_deleted ON clips(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);
CREATE INDEX IF NOT EXISTS idx_transcriptions_clip ON transcriptions(clip_id);
