import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapPool, type MinimalPool } from './pg';

function fakePool(rows: unknown[] = []) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let ended = false;
  const pool: MinimalPool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows };
    },
    async end() { ended = true; },
  };
  return { pool, calls, isEnded: () => ended };
}

test('wrapPool.query — délègue au pool et renvoie les rows', async () => {
  const { pool, calls } = fakePool([{ id: 'u1' }]);
  const db = wrapPool(pool);
  const r = await db.query<{ id: string }>('SELECT * FROM users WHERE id = $1', ['u1']);
  assert.deepEqual(r.rows, [{ id: 'u1' }]);
  assert.deepEqual(calls, [{ sql: 'SELECT * FROM users WHERE id = $1', params: ['u1'] }]);
});

test('wrapPool.exec — exécute sans paramètres (multi-instructions)', async () => {
  const { pool, calls } = fakePool();
  await wrapPool(pool).exec('CREATE TABLE a (i int); CREATE TABLE b (i int);');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params, undefined);
});

test('wrapPool.end — ferme le pool', async () => {
  const { pool, isEnded } = fakePool();
  await wrapPool(pool).end();
  assert.ok(isEnded());
});
