import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from './sql';

// Crée une instance Postgres (WASM) et charge le schéma de stockage.
// En prod : createPgDb (db/pg.ts) vers Neon & co — même interface SqlDb.
export async function createDb(): Promise<PGlite> {
  const db = new PGlite(); // en mémoire (passer un chemin pour persister)
  await ensureSchema(db);
  return db;
}
