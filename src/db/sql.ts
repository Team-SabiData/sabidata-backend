import { readFileSync } from 'node:fs';

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
}
