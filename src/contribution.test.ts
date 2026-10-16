import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { ContributionService } from './services/contributionService';
import { InMemoryAudioStore } from './storage/audioStore';
import { type Principal } from './authz/can';

function principal(role: Principal['role'], competence: Principal['competence'], id = 'u'): Principal {
  return { userId: id, role, competence, audience: role === 'admin' || role === 'moderator' ? 'admin' : 'mobile' };
}
const consent = { commercialUse: true, consentVersion: 'v1' };

test('flux — clip valide (5s, rareté ×3) → peer_review + ledger provisoire 150', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const r = await svc.submitClip('alice', { rarity: 2, durationS: 5, ...consent });
  assert.equal(r.status, 'peer_review');
  assert.equal(r.reward, 150); // 50 × 3 (D4)
  assert.equal(r.licenseTag, 'commercial-v1'); // décision 4
  const ledger = await repo.ledgerFor('alice');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.state, 'provisional');
});

test('flux — auto-check rejette un clip trop court (0s), aucun crédit', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const r = await svc.submitClip('alice', { rarity: 0, durationS: 0, ...consent });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reward, 0);
  assert.equal((await repo.ledgerFor('alice')).length, 0);
});

test('validation ouverte — un contributeur (competence 0) valide un clip normal', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 0, durationS: 4, ...consent }); // requiredCompetence 0
  const bob = principal('contributor', 0, 'bob');
  const next = await svc.nextForValidation(bob);
  assert.equal(next?.id, clipId); // le clip normal d'alice est proposé au contributeur
  const r = await svc.submitVote(bob, clipId, 'correct'); // et il peut voter (pas de 403)
  assert.ok(r.status); // vote accepté
});

test('isolation linguistique — on ne reçoit et ne vote que sa langue/dialecte', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', {
    rarity: 0, durationS: 4, language: 'Mooré', dialect: 'Yatenga', ...consent,
  });

  // Bob parle Dioula → ne reçoit rien et ne peut pas voter
  const bob = await repo.createUser({
    name: 'Bob', role: 'contributor', competence: 1, phoneVerified: true, language: 'Dioula', dialect: 'Bobo',
  });
  const bobP = principal('contributor', 1, bob.id);
  assert.equal(await svc.nextForValidation(bobP), null);
  await assert.rejects(() => svc.submitVote(bobP, clipId, 'correct'), /wrong_language/);

  // Carol parle Mooré/Yatenga → reçoit le clip et vote
  const carol = await repo.createUser({
    name: 'Carol', role: 'contributor', competence: 1, phoneVerified: true, language: 'Mooré', dialect: 'Yatenga',
  });
  const carolP = principal('contributor', 1, carol.id);
  assert.equal((await svc.nextForValidation(carolP))?.id, clipId);
  assert.ok((await svc.submitVote(carolP, clipId, 'correct')).status);
});

test('classroom — le clip soumis est rattaché au classroom du contributeur', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const cls = await repo.createClassroom({ name: 'Groupe', description: '', ownerId: 'x', inviteCode: 'ABC234' });
  const u = await repo.createUser({ name: 'Ali', role: 'contributor', competence: 0, phoneVerified: true, classroomId: cls.id });
  const { clipId } = await svc.submitClip(u.id, { rarity: 0, durationS: 4, ...consent });
  assert.equal((await repo.getClip(clipId))?.classroomId, cls.id);
  assert.equal(await repo.countClipsByClassroom(cls.id), 1);
});

test('transcription — file de clips validés filtrée par langue, pas deux fois', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const clip = await repo.createClip({
    contributorId: 'alice', rarity: 0, durationS: 5, requiredCompetence: 0,
    language: 'Mooré', dialect: 'Yatenga', status: 'validated',
    consent: { commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {} },
  });

  // Dioula → aucun clip à transcrire
  const bob = await repo.createUser({ name: 'Bob', role: 'contributor', competence: 1, phoneVerified: true, language: 'Dioula' });
  assert.equal(await svc.nextForTranscription(principal('contributor', 1, bob.id)), null);

  // Mooré/Yatenga → reçoit le clip validé
  const carol = await repo.createUser({ name: 'Carol', role: 'contributor', competence: 1, phoneVerified: true, language: 'Mooré', dialect: 'Yatenga' });
  const carolP = principal('contributor', 1, carol.id);
  assert.equal((await svc.nextForTranscription(carolP))?.id, clip.id);

  // après transcription → ne le reçoit plus
  await svc.submitTranscription(carolP, { clipId: clip.id, text: 'yaa soaba', writingSystem: 'std', consistency: 1 });
  assert.equal(await svc.nextForTranscription(carolP), null);
});

test('flux — 2 validateurs concordants → clip validated + ledger record CONFIRMÉ', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 1, durationS: 4, ...consent });

  await svc.submitVote(principal('validator', 1, 'bob'), clipId, 'correct');
  const second = await svc.submitVote(principal('validator', 2, 'carol'), clipId, 'correct');
  assert.equal(second.status, 'validated');

  const recordEntry = (await repo.ledgerFor('alice')).find((e) => e.reason === 'record');
  assert.equal(recordEntry?.state, 'confirmed'); // D4 : provisoire → confirmé
  // chaque validateur a touché +20 confirmé
  assert.equal((await repo.ledgerFor('bob'))[0]?.delta, 20);
});

test('flux — double vote interdit (idempotence D7)', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 0, durationS: 4, ...consent });
  await svc.submitVote(principal('validator', 1, 'bob'), clipId, 'correct');
  await assert.rejects(() => svc.submitVote(principal('validator', 1, 'bob'), clipId, 'correct'), /already_voted/);
});

test('flux — validateur sous-qualifié refusé sur contenu rare', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 2, durationS: 4, ...consent }); // requiredCompetence=2
  await assert.rejects(
    () => svc.submitVote(principal('validator', 1, 'bob'), clipId, 'correct'),
    /forbidden/,
  );
});

test('flux — on ne peut pas valider son propre clip', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 0, durationS: 4, ...consent });
  await assert.rejects(() => svc.submitVote(principal('validator', 2, 'alice'), clipId, 'correct'), /own_clip/);
});

test('flux — transcription std + 2 votes qualifiés → tier OR (D1)', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const author = principal('validator', 1, 'alice');
  const { id } = await svc.submitTranscription(author, { text: 'kɛɛrɛ', writingSystem: 'std', consistency: 1 });
  await svc.voteTranscription(principal('validator', 2, 'bob'), id, 'correct', { writingSystem: 'std', consistency: 1 });
  const r = await svc.voteTranscription(principal('validator', 3, 'carol'), id, 'correct', { writingSystem: 'std', consistency: 1 });
  assert.equal(r.tier, 'gold');
});

test('repo — setClipAudio persiste audioPath sur le clip', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const { clipId } = await svc.submitClip('alice', { rarity: 1, durationS: 4, ...consent });
  await repo.setClipAudio(clipId, `${clipId}.m4a`);
  const clip = await repo.getClip(clipId);
  assert.equal(clip?.audioPath, `${clipId}.m4a`);
});

test('flux — clip valide stocke l\'audio et renseigne audioPath', async () => {
  const repo = new InMemoryRepo();
  const store = new InMemoryAudioStore();
  const svc = new ContributionService(repo, store);
  const { clipId } = await svc.submitClip(
    'alice',
    { rarity: 1, durationS: 4, ...consent },
    { buffer: Buffer.from('AUDIO'), ext: 'm4a' },
  );
  const clip = await repo.getClip(clipId);
  assert.equal(clip?.audioPath, `${clipId}.m4a`);
  assert.notEqual(await store.openRead(`${clipId}.m4a`), null);
});

test('flux — clip rejeté (0s) ne stocke AUCUN audio', async () => {
  const repo = new InMemoryRepo();
  const store = new InMemoryAudioStore();
  const svc = new ContributionService(repo, store);
  const { clipId } = await svc.submitClip(
    'alice',
    { rarity: 0, durationS: 0, ...consent },
    { buffer: Buffer.from('AUDIO'), ext: 'm4a' },
  );
  const clip = await repo.getClip(clipId);
  assert.equal(clip?.audioPath, undefined);
  assert.equal(await store.openRead(`${clipId}.m4a`), null);
});
