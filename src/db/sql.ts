import { readFileSync } from 'node:fs';
import { SEED_DIALECTS, SEED_LANGUAGES, SEED_PROMPTS } from './referentialSeed';

// Interface minimale commune à PGlite et au Pool `pg` (via createPgDb) :
// PgRepo et ensureSchema ne dépendent que de ça.
export interface SqlDb {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  // Exécution multi-instructions (chargement du schéma).
  exec(sql: string): Promise<unknown>;
}

// Applique schema.sql si la base est vierge ; no-op sinon (le schéma n'est pas
// en IF NOT EXISTS, on garde par la présence de la table users).
export async function ensureSchema(db: SqlDb): Promise<void> {
  const r = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'",
  );
  if (r.rows.length === 0) {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    await db.exec(schema);
  }
  await ensureMigrations(db);
}

/** Migrations idempotentes pour bases déjà provisionnées (Railway). */
export async function ensureMigrations(db: SqlDb): Promise<void> {
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS client_uuid uuid`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_client_uuid
    ON clips(contributor_id, client_uuid) WHERE client_uuid IS NOT NULL
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS languages (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code       text NOT NULL UNIQUE,
      name_fr    text NOT NULL,
      iso_bcp47  text NOT NULL,
      status     text NOT NULL DEFAULT 'active'
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dialects (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      language_id   uuid NOT NULL REFERENCES languages(id),
      code          text NOT NULL,
      name_fr       text NOT NULL,
      zone          text,
      target_hours  numeric NOT NULL DEFAULT 0,
      UNIQUE (language_id, code)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS prompts (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stable_id     text NOT NULL UNIQUE,
      language_id   uuid NOT NULL REFERENCES languages(id),
      dialect_id    uuid REFERENCES dialects(id),
      text          text NOT NULL,
      writing_system text NOT NULL DEFAULT 'std',
      active        boolean NOT NULL DEFAULT true
    )
  `);

  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS audio_ingest_path text`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS audio_master_path text`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS ingest_sha256 text`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS master_sha256 text`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS duration_ms integer`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS silence_ratio numeric`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS snr_db numeric`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS peak_dbfs numeric`);
  await db.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS audio_quality text`);

  await seedReferential(db);
}

async function seedReferential(db: SqlDb): Promise<void> {
  const existing = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM languages');
  if (Number(existing.rows[0]?.n ?? 0) > 0) return;

  const langIds = new Map<string, string>();
  for (const lang of SEED_LANGUAGES) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO languages (code, name_fr, iso_bcp47, status)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [lang.code, lang.nameFr, lang.isoBcp47, lang.status],
    );
    langIds.set(lang.code, row.rows[0]!.id);
  }

  const dialectIds = new Map<string, string>();
  for (const d of SEED_DIALECTS) {
    const languageId = langIds.get(d.languageCode);
    if (!languageId) continue;
    const row = await db.query<{ id: string }>(
      `INSERT INTO dialects (language_id, code, name_fr, zone, target_hours)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [languageId, d.code, d.nameFr, d.zone, d.targetHours],
    );
    dialectIds.set(`${d.languageCode}:${d.code}`, row.rows[0]!.id);
  }

  for (const p of SEED_PROMPTS) {
    const languageId = langIds.get(p.languageCode);
    const dialectId = dialectIds.get(`${p.languageCode}:${p.dialectCode}`);
    if (!languageId) continue;
    await db.query(
      `INSERT INTO prompts (stable_id, language_id, dialect_id, text, writing_system, active)
       VALUES ($1,$2,$3,$4,'std',true)
       ON CONFLICT (stable_id) DO NOTHING`,
      [p.id, languageId, dialectId ?? null, p.text],
    );
  }
}
