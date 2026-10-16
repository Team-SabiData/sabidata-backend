import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { DatasetExportService, assignSplitsBySpeaker } from './services/datasetExportService';
import { type Principal } from './authz/can';

const admin: Principal = { userId: 'adm', role: 'admin', competence: 3, audience: 'admin' };

test('assignSplitsBySpeaker — un contributeur = un split, couverture train dominante', () => {
  const rows = [
    { contributorId: 'a', dialectKey: 'moore|nord' },
    { contributorId: 'b', dialectKey: 'moore|nord' },
    { contributorId: 'c', dialectKey: 'moore|nord' },
    { contributorId: 'd', dialectKey: 'moore|nord' },
    { contributorId: 'e', dialectKey: 'moore|nord' },
    { contributorId: 'a', dialectKey: 'moore|nord' }, // doublon clip
  ];
  const map = assignSplitsBySpeaker(rows, 'v1.0.0');
  assert.equal(map.size, 5);
  const splits = [...map.values()];
  assert.ok(splits.filter((s) => s === 'train').length >= 3);
});

test('createRelease — publie manifeste ordonné pour clips A+silver', async () => {
  const repo = new InMemoryRepo();
  const svc = new DatasetExportService(repo);
  const alice = await repo.createUser({
    name: 'Alice', role: 'contributor', competence: 0, phoneVerified: true, language: 'moore', dialect: 'nord',
  });
  const bob = await repo.createUser({
    name: 'Bob', role: 'contributor', competence: 1, phoneVerified: true, language: 'moore', dialect: 'nord',
  });

  const consent = {
    commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {},
  };
  const c1 = await repo.createClip({
    contributorId: alice.id, rarity: 0, durationS: 5, requiredCompetence: 0,
    language: 'moore', dialect: 'Nord', status: 'validated', consent,
    audioPath: 'c1_master.wav', audioMasterPath: 'c1_master.wav', audioQuality: 'A', durationMs: 5000,
  });
  const c2 = await repo.createClip({
    contributorId: bob.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    language: 'moore', dialect: 'Nord', status: 'validated', consent,
    audioPath: 'c2_master.wav', audioMasterPath: 'c2_master.wav', audioQuality: 'B', durationMs: 4000,
  });
  // Exclu : qualité F
  await repo.createClip({
    contributorId: bob.id, rarity: 0, durationS: 3, requiredCompetence: 0,
    language: 'moore', dialect: 'Nord', status: 'validated', consent,
    audioPath: 'c3.wav', audioQuality: 'F',
  });

  const t1 = await repo.createTranscription({
    authorId: bob.id, clipId: c1.id, text: 'Phrase un', writingSystem: 'std', consistency: 0.6,
  });
  await repo.setTranscriptionTier(t1.id, 'silver', true);
  const t2 = await repo.createTranscription({
    authorId: alice.id, clipId: c2.id, text: 'Phrase deux', writingSystem: 'std', consistency: 0.6,
  });
  await repo.setTranscriptionTier(t2.id, 'gold', true);

  const r = await svc.createRelease(admin, { version: 'sabidata-mos-v0.1.0' });
  assert.equal(r.itemCount, 2);
  assert.equal(r.release.status, 'published');
  assert.ok(r.release.manifestJsonl?.includes('Phrase'));
  assert.equal((r.release.stats as { clips: number }).clips, 2);

  const got = await svc.getRelease(admin, r.release.id);
  assert.equal(got.items.length, 2);
  assert.equal(got.items[0]!.ordinal, 1);
  assert.ok(got.items[0]!.relativePath.startsWith('audio/moore/'));
});

test('createRelease — refuse version dupliquée', async () => {
  const repo = new InMemoryRepo();
  const svc = new DatasetExportService(repo);
  const u = await repo.createUser({
    name: 'A', role: 'contributor', competence: 0, phoneVerified: true,
  });
  const clip = await repo.createClip({
    contributorId: u.id, rarity: 0, durationS: 5, requiredCompetence: 0,
    language: 'dioula', dialect: 'ouest', status: 'validated',
    consent: { commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {} },
    audioPath: 'x.wav', audioQuality: 'A',
  });
  const tr = await repo.createTranscription({
    authorId: u.id, clipId: clip.id, text: 'ok', writingSystem: 'std', consistency: 0.6,
  });
  await repo.setTranscriptionTier(tr.id, 'silver', true);
  await svc.createRelease(admin, { version: 'v1.0.0' });
  await assert.rejects(() => svc.createRelease(admin, { version: 'v1.0.0' }), /version_exists/);
});
