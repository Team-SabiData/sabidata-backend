import { readFileSync, readdirSync } from 'node:fs';
import { type SqlDb } from './sql';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/**
 * Runner de migrations versionnées, compatible PGlite et Postgres.
 * Chaque fichier `NNN_nom.sql` est appliqué une seule fois, dans l'ordre.
 * La version est enregistrée dans `schema_migrations` dans la même transaction.
 */
export async function migrate(db: SqlDb): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRows = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.version));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.slice(0, -4);
    if (applied.has(version)) continue;

    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    const escaped = version.replace(/'/g, "''");
    await db.exec(
      `BEGIN;\n${sql}\nINSERT INTO schema_migrations (version) VALUES ('${escaped}');\nCOMMIT;`,
    );
    applied.add(version);
  }
}
