import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { ContributionService } from './services/contributionService';
import { GovernanceService } from './services/governanceService';
import { type Principal } from './authz/can';

function principal(role: Principal['role'], competence: Principal['competence'], id = 'mod'): Principal {
  return { userId: id, role, competence, audience: role === 'admin' || role === 'moderator' ? 'admin' : 'mobile' };
}
const consent = { commercialUse: true, consentVersion: 'v1' };

// Place un clip en litige : soumission (ledger provisoire) puis bascule d'état.
async function disputedClip(repo: InMemoryRepo): Promise<string> {
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 1, durationS: 4, ...consent });
  await repo.setClipStatus(clipId, 'disputed');
  return clipId;
}

test('arbitrage — disputed → validated : ledger record CONFIRMÉ + audit écrit', async () => {
  const repo = new InMemoryRepo();
  const gov = new GovernanceService(repo);
  const clipId = await disputedClip(repo);

  const r = await gov.arbitrate(principal('moderator', 3), clipId, 'validated', 'voix claire, conforme');
  assert.equal(r.status, 'validated');

  const clip = await repo.getClip(clipId);
  assert.equal(clip?.status, 'validated');
  const record = (await repo.ledgerFor('alice')).find((e) => e.reason === 'record');
  assert.equal(record?.state, 'confirmed');

  const audit = await repo.listAudit({ entityId: clipId });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, 'clip.arbitrate');
  assert.equal(audit[0]?.actorId, 'mod');
  assert.equal(audit[0]?.reason, 'voix claire, conforme');
  assert.equal((audit[0]?.metadata as { result?: string }).result, 'validated');
});

test('arbitrage — disputed → rejected : ledger record REVERSÉ', async () => {
  const repo = new InMemoryRepo();
  const gov = new GovernanceService(repo);
  const clipId = await disputedClip(repo);

  const r = await gov.arbitrate(principal('moderator', 3), clipId, 'rejected', 'bruit de fond');
  assert.equal(r.status, 'rejected');
  assert.equal((await repo.getClip(clipId))?.status, 'rejected');
  const record = (await repo.ledgerFor('alice')).find((e) => e.reason === 'record');
  assert.equal(record?.state, 'reversed');
});

test('arbitrage — refusé si le clip n\'est pas en litige', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const gov = new GovernanceService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 0, durationS: 4, ...consent }); // peer_review
  await assert.rejects(() => gov.arbitrate(principal('moderator', 3), clipId, 'validated', 'x'), /not_disputed/);
});

test('arbitrage — refusé sans la permission dispute.arbitrate (contributeur)', async () => {
  const repo = new InMemoryRepo();
  const gov = new GovernanceService(repo);
  const clipId = await disputedClip(repo);
  await assert.rejects(
    () => gov.arbitrate(principal('contributor', 0, 'eve'), clipId, 'validated', 'x'),
    /forbidden/,
  );
});

test('arbitrage — clip introuvable → not_found', async () => {
  const repo = new InMemoryRepo();
  const gov = new GovernanceService(repo);
  await assert.rejects(() => gov.arbitrate(principal('admin', 3), 'c_inexistant', 'validated', 'x'), /clip/);
});

test('journal d\'audit — append-only, filtrable par acteur et par entité', async () => {
  const repo = new InMemoryRepo();
  const gov = new GovernanceService(repo);
  const a = await disputedClip(repo);
  const b = await disputedClip(repo);
  await gov.arbitrate(principal('moderator', 3, 'mod1'), a, 'validated', 'ok');
  await gov.arbitrate(principal('admin', 3, 'admin1'), b, 'rejected', 'ko');

  assert.equal((await gov.listAudit()).length, 2);
  assert.equal((await gov.listAudit({ entityId: a })).length, 1);
  assert.equal((await gov.listAudit({ actorId: 'admin1' }))[0]?.entityId, b);
});
