-- =============================================================================
-- SabiData — Schéma de STOCKAGE (PostgreSQL 16 / PGlite)
-- Consolidé v1 + delta-v2. Storage-only : la logique métier (auto-check,
-- consensus, tier, ledger 2 phases) vit dans le service TS (déjà testé) ;
-- la base ne porte que tables + contraintes + idempotence.
-- gen_random_uuid() est en core (PG13+), pas besoin de pgcrypto.
-- =============================================================================

CREATE TYPE user_role      AS ENUM ('contributor','validator','moderator','admin');
CREATE TYPE clip_status    AS ENUM ('pending','auto_checked','peer_review','validated','rejected','disputed');
CREATE TYPE verdict_type   AS ENUM ('correct','problem','unsure');
CREATE TYPE ledger_state   AS ENUM ('provisional','confirmed','reversed');
CREATE TYPE ledger_reason  AS ENUM ('record','validate','transcribe','convert','admin_adjustment','withdrawal','withdrawal_refund');
CREATE TYPE writing_system AS ENUM ('std','phon');
CREATE TYPE quality_tier   AS ENUM ('gold','silver','bronze','raw');

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  role            user_role NOT NULL DEFAULT 'contributor',
  competence      smallint NOT NULL DEFAULT 0 CHECK (competence BETWEEN 0 AND 3),
  email           text UNIQUE,
  phone           text UNIQUE,
  password_hash   text,
  totp_secret     text,
  phone_verified  boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active',
  language           text,
  dialect            text,
  region             text,
  commercial_consent boolean NOT NULL DEFAULT false,
  classroom_id    uuid, -- classroom courant du contributeur (nullable)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Classroom : groupe de collecte (école, association) rejoint par code d'invitation.
CREATE TABLE classrooms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  owner_id     uuid NOT NULL REFERENCES users(id),
  invite_code  text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  phone      text PRIMARY KEY,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE clips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id      uuid NOT NULL REFERENCES users(id),
  prompt_id           text,
  rarity              smallint NOT NULL CHECK (rarity BETWEEN 0 AND 2),
  duration_s          integer NOT NULL,
  required_competence smallint NOT NULL DEFAULT 1,
  -- classification linguistique (issue du profil contributeur) → regroupement en BD
  language            text,
  dialect             text,
  region              text,
  classroom_id        uuid, -- classroom du contributeur au moment de l'envoi
  status              clip_status NOT NULL DEFAULT 'pending',
  -- décision 4 : chaîne de consentement (immuable applicativement)
  commercial_use      boolean NOT NULL,
  consent_version     text NOT NULL,
  license_tag         text NOT NULL,
  provenance          jsonb,
  autocheck           jsonb,
  audio_path          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_clips_status ON clips(status);
CREATE INDEX idx_clips_lang_dialect ON clips(language, dialect);

CREATE TABLE transcriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES users(id),
  clip_id        uuid REFERENCES clips(id),
  archive_id     uuid,
  text           text NOT NULL,
  writing_system writing_system NOT NULL,
  consistency    numeric NOT NULL DEFAULT 0.60,
  matches_audio  boolean,
  tier           quality_tier,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE votes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  validator_id        uuid NOT NULL REFERENCES users(id),
  clip_id             uuid REFERENCES clips(id) ON DELETE CASCADE,
  transcription_id    uuid REFERENCES transcriptions(id) ON DELETE CASCADE,
  verdict             verdict_type NOT NULL,
  reviewer_competence smallint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((clip_id IS NOT NULL)::int + (transcription_id IS NOT NULL)::int = 1),
  UNIQUE (clip_id, validator_id),            -- idempotence D7
  UNIQUE (transcription_id, validator_id)
);

CREATE TABLE points_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),
  delta                integer NOT NULL,
  reason               ledger_reason NOT NULL,
  state                ledger_state NOT NULL DEFAULT 'confirmed',
  ref_clip_id          uuid REFERENCES clips(id),
  ref_transcription_id uuid REFERENCES transcriptions(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_user ON points_ledger(user_id, state);

CREATE TABLE withdrawals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  amount_fcfa integer NOT NULL CHECK (amount_fcfa >= 500),
  provider    text NOT NULL,
  status      text NOT NULL DEFAULT 'processing',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Journal d'audit immuable (delta-v2 §3/§6) : trace de chaque action de
-- gouvernance admin. Append-only — aucune route n'expose UPDATE/DELETE.
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NOT NULL REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  reason      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
