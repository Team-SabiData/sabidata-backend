import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './db/pglite';
import { PgRepo } from './ports/pgRepo';
import { ContributionService } from './services/contributionService';
import { GovernanceService } from './services/governanceService';
import { type Principal } from './authz/can';

function principal(id: string, competence: Principal['competence'] = 1): Principal {
  return { userId: id, role: 'validator', competence, audience: 'mobile' };
}

test('PG — le schéma se charge sur un vrai moteur Postgres (PGlite)', async () => {
  const db = await createDb();
  const r = await db.query<{ count: string }>(
    "SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public'",
  );
  assert.ok(Number(r.rows[0]?.count) >= 6); // tables créées
});

test('PG — flux complet sur PgRepo : clip → peer_review → validated + ledger confirmé', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);
  const svc = new ContributionService(repo);

  // 3 utilisateurs réels en base
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 0, phoneVerified: false });
  const bob = await repo.createUser({ name: 'Bob', role: 'validator', competence: 2, phoneVerified: false });
  const carol = await repo.createUser({ name: 'Carol', role: 'validator', competence: 2, phoneVerified: false });

  const sub = await svc.submitClip(alice.id, {
    rarity: 2, durationS: 5, commercialUse: true, consentVersion: 'v1',
  });
  assert.equal(sub.status, 'peer_review');
  assert.equal(sub.reward, 150);

  // ledger provisoire persisté
  let ledger = await repo.ledgerFor(alice.id);
  assert.equal(ledger[0]?.state, 'provisional');

  await svc.submitVote(principal(bob.id, 2), sub.clipId, 'correct');
  const second = await svc.submitVote(principal(carol.id, 2), sub.clipId, 'correct');
  assert.equal(second.status, 'validated');

  // ledger record confirmé en base
  ledger = await repo.ledgerFor(alice.id);
  assert.equal(ledger.find((e) => e.reason === 'record')?.state, 'confirmed');
});

test('PG — contrainte d\'idempotence : double vote rejeté par UNIQUE en base', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);
  const svc = new ContributionService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 0, phoneVerified: false });
  const bob = await repo.createUser({ name: 'Bob', role: 'validator', competence: 2, phoneVerified: false });
  const sub = await svc.submitClip(alice.id, { rarity: 1, durationS: 4, commercialUse: false, consentVersion: 'v1' });
  await svc.submitVote(principal(bob.id), sub.clipId, 'correct');
  await assert.rejects(() => svc.submitVote(principal(bob.id), sub.clipId, 'correct'));
});

test('PG — arbitrage d\'un litige + journal d\'audit persistés', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);
  const svc = new ContributionService(repo);
  const gov = new GovernanceService(repo);

  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 0, phoneVerified: false });
  const mod = await repo.createUser({ name: 'Mod', role: 'moderator', competence: 3, phoneVerified: true });
  const sub = await svc.submitClip(alice.id, { rarity: 1, durationS: 4, commercialUse: true, consentVersion: 'v1' });
  await repo.setClipStatus(sub.clipId, 'disputed');

  const modP: Principal = { userId: mod.id, role: 'moderator', competence: 3, audience: 'admin' };
  const r = await gov.arbitrate(modP, sub.clipId, 'validated', 'conforme');
  assert.equal(r.status, 'validated');

  // état + ledger persistés
  assert.equal((await repo.getClip(sub.clipId))?.status, 'validated');
  assert.equal((await repo.ledgerFor(alice.id)).find((e) => e.reason === 'record')?.state, 'confirmed');

  // journal d'audit persisté et filtrable
  const audit = await gov.listAudit({ entityId: sub.clipId });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, 'clip.arbitrate');
  assert.equal(audit[0]?.actorId, mod.id);
});

test('PG — consentement persisté (décision 4)', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);
  const svc = new ContributionService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 0, phoneVerified: false });
  const sub = await svc.submitClip(alice.id, { rarity: 0, durationS: 4, commercialUse: true, consentVersion: 'v1' });
  const clip = await repo.getClip(sub.clipId);
  assert.equal(clip?.consent.licenseTag, 'commercial-v1');
  assert.equal(clip?.consent.commercialUse, true);
});
