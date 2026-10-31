#!/usr/bin/env tsx
/**
 * Applique le schéma + les migrations sur la base ciblée par DATABASE_URL.
 * À utiliser sur une branche Neon/staging AVANT de déployer.
 *
 *   DATABASE_URL='postgresql://…?sslmode=require' npm run db:migrate
 */
import { createPgDb } from '../src/db/pg';
import { ensureSchema } from '../src/db/sql';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL requis');
    process.exit(1);
  }

  const db = createPgDb(url);
  try {
    await ensureSchema(db);
    const rows = await db.query<{ version: string; applied_at: string }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
    );
    console.log('Migrations appliquées :');
    for (const r of rows.rows) {
      console.log(`  ${r.version}  ${r.applied_at}`);
    }
  } finally {
    await db.end();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
