import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, DEV_TOTP_SECRET, seedDevAdmin } from './server';
import { InMemoryRepo } from './ports/repo';
import { InMemoryAudioStore } from './storage/audioStore';
import { ContributionService } from './services/contributionService';
import { DatasetExportService } from './services/datasetExportService';
import { currentTotp } from './auth/totp';
import { resetRateLimits } from './http/rateLimit';
import { type Principal } from './authz/can';

const consent = { commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {} };

function principal(role: Principal['role'], id: string, competence: 0 | 1 | 2 | 3 = 1): Principal {
  return { userId: id, role, competence, audience: 'mobile' };
}

async function adminToken(app: ReturnType<typeof buildServer>) {
  resetRateLimits();
  const login = await app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email: 'admin@sabidata.bf', password: 'admin123' },
  });
  const { challenge } = login.json() as { challenge: string };
  const totp = await app.inject({
    method: 'POST', url: '/admin/auth/totp',
    payload: { challenge, code: currentTotp(DEV_TOTP_SECRET) },
  });
  return (totp.json() as { access: string }).access;
}

test('GET /admin/quality — clips + transcriptions, votes et pagination', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const token = await adminToken(app);
  const H = { authorization: `Bearer ${token}` };

  const awa = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const clip = await repo.createClip({
    contributorId: awa.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    status: 'peer_review', language: 'moore', dialect: 'nord', consent,
  });
  const tr = await repo.createTranscription({
    authorId: awa.id, clipId: clip.id, text: 'phrase test', writingSystem: 'std', consistency: 0.6,
  });
  await repo.createVote({ clipId: clip.id, validatorId: 'v1', verdict: 'problem', reviewerCompetence: 1 });
  await repo.createVote({ transcriptionId: tr.id, validatorId: 'v2', verdict: 'correct', reviewerCompetence: 2 });
  await repo.setClipModeration(clip.id, { rejectionCount: 1 });

  const res = await app.inject({
    method: 'GET', url: '/admin/quality?type=all&language=moore&page=1&limit=1', headers: H,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    total: { clips: number; transcriptions: number };
    clips: Array<{ id: string; rejectionCount: number; votes: { problem: number } }>;
    transcriptions: Array<{ id: string; status: string; votes: { correct: number } }>;
  };
  assert.deepEqual(body.total, { clips: 1, transcriptions: 1 });
  assert.equal(body.clips[0]?.id, clip.id);
  assert.equal(body.clips[0]?.rejectionCount, 1);
  assert.equal(body.clips[0]?.votes.problem, 1);
  assert.equal(body.transcriptions[0]?.id, tr.id);
  assert.equal(body.transcriptions[0]?.status, 'pending');
  assert.equal(body.transcriptions[0]?.votes.correct, 1);

  const invalid = await app.inject({ method: 'GET', url: '/admin/quality?type=nope', headers: H });
  assert.equal(invalid.statusCode, 400);
});

test('rejet qualité — 2 votes problem : soft-delete, purge audio, audit', async () => {
  const repo = new InMemoryRepo();
  const store = new InMemoryAudioStore();
  const svc = new ContributionService(repo, store);

  const awa = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const v1 = await repo.createUser({
    name: 'V1', role: 'validator', competence: 1, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const v2 = await repo.createUser({
    name: 'V2', role: 'validator', competence: 1, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const clip = await repo.createClip({
    contributorId: awa.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    status: 'peer_review', language: 'moore', dialect: 'nord', consent,
    audioQuality: 'A',
  });
  const audioPath = await store.save(clip.id, Buffer.from('AUDIO'), 'm4a');
  await repo.setClipAudio(clip.id, audioPath);
  await repo.setClipMedia(clip.id, {
    audioPath, audioIngestPath: audioPath, audioMasterPath: audioPath,
    ingestSha256: 'a', masterSha256: 'b', durationS: 4, durationMs: 4000,
    silenceRatio: 0, snrDb: 30, peakDbfs: -3, audioQuality: 'A',
    autocheck: {}, status: 'peer_review',
  });

  const first = await svc.submitVote(principal('validator', v1.id), clip.id, 'problem');
  assert.equal(first.status, 'peer_review');
  assert.equal((await repo.getClip(clip.id))?.rejectionCount, 1);
  assert.ok(await store.openRead(audioPath));

  const second = await svc.submitVote(principal('validator', v2.id), clip.id, 'problem');
  assert.equal(second.status, 'rejected');
  const rejected = await repo.getClip(clip.id);
  assert.equal(rejected?.status, 'rejected');
  assert.equal(rejected?.rejectionCount, 2);
  assert.ok(rejected?.deletedAt instanceof Date);
  assert.equal(rejected?.audioPath, undefined);
  assert.equal(rejected?.audioMasterPath, undefined);
  assert.equal(await store.openRead(audioPath), null);
  const audit = await repo.listAudit({ action: 'clip.reject' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.entityId, clip.id);
});

test('rejet transcription — 2 votes problem : statut rejected + soft-delete', async () => {
  const repo = new InMemoryRepo();
  const svc = new ContributionService(repo);
  const contributor = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const author = await repo.createUser({
    name: 'Trans', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const v1 = await repo.createUser({
    name: 'V1', role: 'validator', competence: 1, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const v2 = await repo.createUser({
    name: 'V2', role: 'validator', competence: 1, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const clip = await repo.createClip({
    contributorId: contributor.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    status: 'validated', language: 'moore', dialect: 'nord', consent,
  });
  const tr = await repo.createTranscription({
    authorId: author.id, clipId: clip.id, text: 'faux', writingSystem: 'std', consistency: 0.6,
  });
  const input = { writingSystem: 'std' as const, consistency: 0.6 };

  await svc.voteTranscription(principal('validator', v1.id), tr.id, 'problem', input);
  const first = await repo.getTranscription(tr.id);
  assert.notEqual(first?.status, 'rejected');
  assert.equal(first?.rejectionCount, 1);

  await svc.voteTranscription(principal('validator', v2.id), tr.id, 'problem', input);
  const rejected = await repo.getTranscription(tr.id);
  assert.equal(rejected?.status, 'rejected');
  assert.equal(rejected?.rejectionCount, 2);
  assert.ok(rejected?.deletedAt instanceof Date);
});

test('catalogue dataset — tout le validé, tous tiers, filtres, JSONL et ZIP', async () => {
  const repo = new InMemoryRepo();
  const store = new InMemoryAudioStore();
  const svc = new DatasetExportService(repo, store);
  const admin: Principal = { userId: 'adm', role: 'admin', competence: 3, audience: 'admin' };
  const awa = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'moore', dialect: 'nord',
  });
  const bob = await repo.createUser({
    name: 'Bob', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'dioula', dialect: 'ouest',
  });

  const rows: Array<{ id: string; quality: 'A' | 'B' | 'C'; tier: 'gold' | 'silver' | 'bronze'; user: string; lang: string }> = [];
  for (const [i, spec] of [
    { quality: 'A' as const, tier: 'silver' as const, user: awa.id, lang: 'moore' },
    { quality: 'B' as const, tier: 'bronze' as const, user: awa.id, lang: 'moore' },
    { quality: 'C' as const, tier: 'gold' as const, user: bob.id, lang: 'dioula' },
  ].entries()) {
    const clip = await repo.createClip({
      contributorId: spec.user, rarity: 0, durationS: 4 + i, requiredCompetence: 0,
      status: 'validated', language: spec.lang, dialect: 'nord', consent,
      audioQuality: spec.quality, audioMasterPath: `${spec.user}-${i}.m4a`,
    });
    await store.save(`${spec.user}-${i}`, Buffer.from(`AUDIO${i}`), 'm4a');
    await repo.setClipAudio(clip.id, `${spec.user}-${i}.m4a`);
    const tr = await repo.createTranscription({
      authorId: spec.user, clipId: clip.id, text: `phrase ${i}`, writingSystem: 'std', consistency: 0.6,
    });
    await repo.setTranscriptionTier(tr.id, spec.tier, true);
    rows.push({ id: clip.id, ...spec });
  }
  const deleted = await repo.createClip({
    contributorId: awa.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    status: 'validated', language: 'moore', dialect: 'nord', consent,
    audioQuality: 'A', audioMasterPath: 'deleted.m4a', deletedAt: new Date(),
  });
  await repo.createTranscription({
    authorId: awa.id, clipId: deleted.id, text: 'supprimé', writingSystem: 'std', consistency: 0.6,
  });

  const catalog = await svc.catalog(admin, 'quality');
  assert.equal(catalog.total, 3);
  assert.deepEqual(catalog.groups, [
    { key: 'A', count: 1 },
    { key: 'B', count: 1 },
    { key: 'C', count: 1 },
  ]);
  const byTier = await svc.catalog(admin, 'tier', { language: 'moore' });
  assert.deepEqual(byTier.groups, [
    { key: 'bronze', count: 1 },
    { key: 'silver', count: 1 },
  ]);

  const jsonl = await svc.catalogJsonl(admin);
  const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l) as { sentence: string; annotation_tier: string });
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.annotation_tier === 'bronze'));
  assert.ok(lines.some((l) => l.sentence === 'phrase 2'));

  const { archive, itemCount } = await svc.catalogArchive(admin);
  assert.equal(itemCount, 3);
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  const zip = Buffer.concat(chunks);
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  assert.ok(rows.length === 3);
});
