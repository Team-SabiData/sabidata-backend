import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from './sql';
import { PgRepo } from '../ports/pgRepo';

test('ensureSchema — applique le schéma sur une base vierge', async () => {
  const db = new PGlite();
  await ensureSchema(db);
  const r = await db.query<{ count: string }>(
    "SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public'",
  );
  assert.ok(Number(r.rows[0]?.count) >= 6);
});

test('ensureSchema — idempotent : un second appel ne casse rien', async () => {
  const db = new PGlite();
  await ensureSchema(db);
  await ensureSchema(db); // sans garde, CREATE TYPE/TABLE relèverait une erreur
  const repo = new PgRepo(db);
  const u = await repo.createUser({ name: 'Awa', role: 'contributor', competence: 0, phoneVerified: false });
  assert.equal((await repo.findUserById(u.id))?.name, 'Awa');
});
