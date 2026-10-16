import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { buildServer } from './server';

// GET /api/regions doit rester accessible sans authentification : c'est de
// l'agrégat (comptes de clips par région), pas de la donnée personnelle —
// utilisé par l'écran public de sélection de dialecte.
test('GET /api/regions : public, aucun header Authorization requis', async () => {
  const app = buildServer(new InMemoryRepo());

  const res = await app.inject({ method: 'GET', url: '/api/regions' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 0);
  assert.ok('region' in body[0] && 'coveragePct' in body[0]);
});
