import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './db/pglite';
import { PgRepo } from './ports/pgRepo';
import { ContributionService } from './services/contributionService';
import { GovernanceService } from './services/governanceService';
import { SupportService } from './services/supportService';
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
    durationS: 5, commercialUse: true, consentVersion: 'v1', region: 'Dori',
  });
  assert.equal(sub.status, 'peer_review');
  assert.equal(sub.reward, 1); // pas d'audio → barème C

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

test('PG — qualité : rejection_count, soft-delete et statuts transcriptions', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);
  const alice = await repo.createUser({
    name: 'Alice', role: 'contributor', competence: 0, phoneVerified: false,
    language: 'moore', dialect: 'nord',
  });
  const clip = await repo.createClip({
    contributorId: alice.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    language: 'moore', dialect: 'nord', status: 'peer_review',
    consent: {
      commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {},
    },
    audioQuality: 'A',
  });
  await repo.setClipAudio(clip.id, 'clip.m4a');
  await repo.setClipModeration(clip.id, { rejectionCount: 2, deletedAt: new Date() });
  await repo.clearClipAudio(clip.id);
  const moderated = await repo.getClip(clip.id);
  assert.equal(moderated?.rejectionCount, 2);
  assert.ok(moderated?.deletedAt instanceof Date);
  assert.equal(moderated?.audioPath, undefined);

  const tr = await repo.createTranscription({
    authorId: alice.id, clipId: clip.id, text: 'phrase', writingSystem: 'std', consistency: 0.6,
  });
  assert.equal(tr.status, 'pending');
  await repo.setTranscriptionModeration(tr.id, {
    status: 'rejected', rejectionCount: 2, deletedAt: new Date(), tier: 'bronze', matchesAudio: false,
  });
  const rejected = await repo.getTranscription(tr.id);
  assert.equal(rejected?.status, 'rejected');
  assert.equal(rejected?.rejectionCount, 2);
  assert.equal(rejected?.tier, 'bronze');
  assert.equal(rejected?.matchesAudio, false);

  const qualityTrs = await repo.listQualityTranscriptions({ status: 'rejected', language: 'moore' });
  assert.equal(qualityTrs.length, 1);
  assert.equal(qualityTrs[0]?.language, 'moore');
  const qualityClips = await repo.listQualityClips({ language: 'moore' });
  assert.equal(qualityClips.length, 1);
});

test('PG — référentiel : updates, soft-delete et compteurs de références', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);

  const lang = await repo.createLanguage({ code: 'bwamu', nameFr: 'Bwamu', isoBcp47: 'bw' });
  assert.equal((await repo.findLanguageByCode('bwamu'))?.id, lang.id);
  const updatedLang = await repo.updateLanguage('bwamu', { nameFr: 'Bwamu (Bobo)' });
  assert.equal(updatedLang?.nameFr, 'Bwamu (Bobo)');

  const dialect = await repo.createDialect({
    languageCode: 'bwamu', code: 'sud', nameFr: 'Bwamu du Sud', zone: 'Hauts-Bassins',
  });
  const updatedDialect = await repo.updateDialect(dialect.id, {
    nameFr: 'Bwamu sud', zone: null, targetHours: 8,
  });
  assert.equal(updatedDialect?.nameFr, 'Bwamu sud');
  assert.equal(updatedDialect?.zone, undefined);
  assert.equal(updatedDialect?.targetHours, 8);

  await repo.createPrompt({
    stableId: 'bwamu-sud-001', languageCode: 'bwamu', dialectCode: 'sud', text: 'Avant',
  });
  const updatedPrompt = await repo.updatePrompt('bwamu-sud-001', { text: 'Après' });
  assert.equal(updatedPrompt?.text, 'Après');

  const contributor = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0, phoneVerified: true,
  });
  await repo.updateUser(contributor.id, { language: 'bwamu', dialect: 'sud' });
  const clip = await repo.createClip({
    contributorId: contributor.id, promptId: 'bwamu-sud-001', rarity: 0, durationS: 4,
    requiredCompetence: 0, language: 'bwamu', dialect: 'sud', status: 'peer_review',
    consent: {
      commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {},
    },
  });

  assert.deepEqual(await repo.countLanguageRefs('bwamu'), {
    dialects: 1, prompts: 1, users: 1, clips: 1,
  });
  assert.deepEqual(await repo.countDialectRefs(dialect.id), {
    prompts: 1, users: 1, clips: 1,
  });
  assert.deepEqual(await repo.countPromptRefs('bwamu-sud-001'), { clips: 1 });

  // Soft-delete dans l'ordre feuille → racine.
  await repo.updatePrompt('bwamu-sud-001', { active: false });
  await repo.updateDialect(dialect.id, { active: false });
  await repo.updateLanguage('bwamu', { status: 'inactive' });

  assert.equal((await repo.getPromptByStableId('bwamu-sud-001'))?.active, false);
  assert.equal((await repo.findDialectById(dialect.id))?.active, false);
  assert.equal((await repo.findLanguageByCode('bwamu'))?.status, 'inactive');
  assert.equal((await repo.listPrompts()).some((p) => p.stableId === 'bwamu-sud-001'), false);
  assert.equal(
    (await repo.listPrompts(undefined, { includeInactive: true }))
      .some((p) => p.stableId === 'bwamu-sud-001'),
    true,
  );
  assert.equal((await repo.listDialects('bwamu')).length, 0);
  assert.equal((await repo.listDialects('bwamu', { includeInactive: true })).length, 1);
  assert.equal((await repo.listLanguages()).some((l) => l.code === 'bwamu'), false);
  assert.equal(
    (await repo.listLanguages({ includeInactive: true })).find((l) => l.code === 'bwamu')?.status,
    'inactive',
  );
  void clip;
});

test('PG — chat support persisté : conversation unique, messages, clôture', async () => {
  const db = await createDb();
  const repo = new PgRepo(db);
  const svc = new SupportService(repo);

  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 0, phoneVerified: false });
  const mod = await repo.createUser({ name: 'Mod', role: 'moderator', competence: 3, phoneVerified: true });
  const aliceP: Principal = { userId: alice.id, role: 'contributor', competence: 0, audience: 'mobile' };
  const modP: Principal = { userId: mod.id, role: 'moderator', competence: 3, audience: 'admin' };

  const conv = await svc.openConversation(aliceP, { subject: 'Aide' });
  assert.equal((await svc.openConversation(aliceP, {})).id, conv.id);

  const first = await svc.postMessage(aliceP, conv.id, 'Bonjour');
  const reply = await svc.postStaffMessage(modP, conv.id, 'Bonjour Alice');
  assert.equal(reply.senderRole, 'staff');

  const polled = await svc.listMessages(aliceP, conv.id, {
    after: first.createdAt.toISOString(),
  });
  assert.deepEqual(polled.map((m) => m.id), [reply.id]);
  assert.ok((await repo.getConversation(conv.id))?.lastMessageAt);

  const staffList = await svc.listForStaff(modP);
  assert.equal(staffList.conversations[0]?.userName, 'Alice');
  assert.equal(staffList.conversations[0]?.unreadForStaff, 1);

  await svc.markStaffRead(modP, conv.id);
  assert.equal((await svc.getForStaff(modP, conv.id)).unreadForStaff, 0);

  await svc.closeForStaff(modP, conv.id);
  assert.equal((await repo.getConversation(conv.id))?.status, 'closed');
  await assert.rejects(() => svc.postMessage(aliceP, conv.id, 'encore'), /CONVERSATION_CLOSED/);
  assert.notEqual((await svc.openConversation(aliceP, {})).id, conv.id);
});
