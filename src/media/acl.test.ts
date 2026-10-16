import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from '../ports/repo';
import { ContributionService } from '../services/contributionService';
import { type Principal } from '../authz/can';

function principal(role: Principal['role'], competence: Principal['competence'], id: string): Principal {
  return {
    userId: id,
    role,
    competence,
    audience: role === 'admin' || role === 'moderator' ? 'admin' : 'mobile',
  };
}

test('ACL audio — contributeur OK, autre langue 403 logique', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const alice = await repo.createUser({
    name: 'Alice', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'Mooré', dialect: 'Yatenga',
  });
  const { clipId } = await svc.submitClip(alice.id, {
    durationS: 5, commercialUse: true, consentVersion: 'v1',
    language: 'Mooré', dialect: 'Yatenga',
  }, { buffer: Buffer.alloc(1000, 1), ext: 'm4a' });
  const clip = (await repo.getClip(clipId))!;

  assert.equal(await svc.canReadAudio(principal('contributor', 0, alice.id), clip), true);

  const bob = await repo.createUser({
    name: 'Bob', role: 'contributor', competence: 1, phoneVerified: true,
    language: 'Dioula', dialect: 'Bobo',
  });
  assert.equal(await svc.canReadAudio(principal('contributor', 1, bob.id), clip), false);

  assert.equal(await svc.canReadAudio(principal('admin', 3, 'admin1'), clip), true);
});

test('media job — quality A + peer_review quand buffer OK', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const r = await svc.submitClip('u1', {
    durationS: 99, commercialUse: true, consentVersion: 'v1',
  }, { buffer: Buffer.alloc(2000, 2), ext: 'm4a' });
  assert.equal(r.status, 'peer_review');
  assert.equal(r.audioQuality, 'A');
  const clip = await repo.getClip(r.clipId);
  assert.equal(clip?.audioQuality, 'A');
  assert.ok(clip?.audioMasterPath);
  assert.equal(clip?.durationS, 5); // stub 5000ms
});
