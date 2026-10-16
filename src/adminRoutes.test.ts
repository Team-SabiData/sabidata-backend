import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, DEV_TOTP_SECRET, seedDevAdmin } from './server';
import { InMemoryRepo } from './ports/repo';
import { InMemoryAudioStore } from './storage/audioStore';
import { currentTotp } from './auth/totp';
import { hashPassword } from './auth/crypto';

async function adminToken(app: ReturnType<typeof buildServer>) {
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

// Provisionne un modérateur (2FA) et renvoie son token admin — sert à vérifier
// qu'un porteur de content.read_any SANS wallet.read ne voit ni solde ni PII.
async function moderatorToken(app: ReturnType<typeof buildServer>, repo: InMemoryRepo) {
  const mod = await repo.createUser({
    name: 'Modo', role: 'moderator', competence: 2, email: 'modo@sabidata.bf',
    passwordHash: hashPassword('modo1234'), phoneVerified: true, totpSecret: DEV_TOTP_SECRET,
  });
  const login = await app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email: 'modo@sabidata.bf', password: 'modo1234' },
  });
  const { challenge } = login.json() as { challenge: string };
  const totp = await app.inject({
    method: 'POST', url: '/admin/auth/totp',
    payload: { challenge, code: currentTotp(DEV_TOTP_SECRET) },
  });
  void mod;
  return (totp.json() as { access: string }).access;
}

test('cycle complet : créer → créditer → suspendre → login refusé → supprimer', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const tk = await adminToken(app);
  const H = { authorization: `Bearer ${tk}` };

  // créer
  const created = await app.inject({
    method: 'POST', url: '/admin/users', headers: H,
    payload: { name: 'Awa Test', phone: '70000009', role: 'contributor' },
  });
  assert.equal(created.statusCode, 201);
  const { id } = created.json() as { id: string };

  // créditer
  const adj = await app.inject({
    method: 'POST', url: `/admin/users/${id}/adjustments`, headers: H,
    payload: { delta: 500, reason: 'bonus de lancement' },
  });
  assert.equal(adj.statusCode, 200);
  assert.equal((adj.json() as { pointsTotal: number }).pointsTotal, 500);

  // wallet + ledger visibles
  const wallet = await app.inject({ method: 'GET', url: `/admin/users/${id}/wallet`, headers: H });
  assert.equal((wallet.json() as { pointsTotal: number }).pointsTotal, 500);
  const ledger = await app.inject({ method: 'GET', url: `/admin/users/${id}/ledger`, headers: H });
  assert.equal((ledger.json() as { entries: unknown[] }).entries.length, 1);

  // suspendre sans motif → 400 ; avec motif → ok
  const noReason = await app.inject({
    method: 'PATCH', url: `/admin/users/${id}`, headers: H, payload: { status: 'suspended' },
  });
  assert.equal(noReason.statusCode, 400);
  const susp = await app.inject({
    method: 'PATCH', url: `/admin/users/${id}`, headers: H,
    payload: { status: 'suspended', reason: 'vérification en cours' },
  });
  assert.equal(susp.statusCode, 200);

  // login mobile refusé (compte suspendu) — flux OTP
  const otpReq = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { phone: '70000009' } });
  assert.equal(otpReq.statusCode, 403);
  assert.match(otpReq.body, /ACCOUNT_DISABLED/);

  // supprimer (motif requis)
  const del = await app.inject({
    method: 'DELETE', url: `/admin/users/${id}`, headers: H, payload: { reason: 'demande utilisateur' },
  });
  assert.equal(del.statusCode, 200);
  const users = await app.inject({ method: 'GET', url: '/admin/users', headers: H });
  const list = (users.json() as { users: { id: string; status: string; name: string }[] }).users;
  const deleted = list.find((u) => u.id === id);
  assert.equal(deleted?.status, 'deleted');
  assert.equal(deleted?.name, 'Utilisateur supprimé');
});

test('PATCH /admin/users/:id (rôle) : motif requis, promotion motivée journalisée', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const tk = await adminToken(app);
  const H = { authorization: `Bearer ${tk}` };

  const created = await app.inject({
    method: 'POST', url: '/admin/users', headers: H,
    payload: { name: 'Awa Rôle', phone: '70000099', role: 'contributor' },
  });
  const { id } = created.json() as { id: string };

  // sans motif → 400 REASON_REQUIRED
  const noReason = await app.inject({
    method: 'PATCH', url: `/admin/users/${id}`, headers: H, payload: { role: 'validator' },
  });
  assert.equal(noReason.statusCode, 400);
  assert.match(noReason.body, /REASON_REQUIRED/);

  // promotion valide avec motif
  const promote = await app.inject({
    method: 'PATCH', url: `/admin/users/${id}`, headers: H,
    payload: { role: 'validator', competence: 1, reason: 'montée en compétence' },
  });
  assert.equal(promote.statusCode, 200);
  assert.equal((promote.json() as { role: string }).role, 'validator');

  const audit = await app.inject({ method: 'GET', url: '/admin/audit-log?action=user.update', headers: H });
  const entries = (audit.json() as { entries: { reason?: string }[] }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'montée en compétence');
});

test('GET /admin/users : un modérateur (content.read_any sans wallet.read) ne voit ni solde ni PII', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const contributor = await repo.createUser({
    name: 'Awa PII', role: 'contributor', competence: 0, email: 'awa@x.bf', phone: '70000042', phoneVerified: true,
  });
  await repo.addLedger({ userId: contributor.id, delta: 500, reason: 'record', state: 'confirmed' });
  const app = buildServer(repo);

  const modTk = await moderatorToken(app, repo);
  const asMod = await app.inject({ method: 'GET', url: '/admin/users', headers: { authorization: `Bearer ${modTk}` } });
  assert.equal(asMod.statusCode, 200);
  const modList = (asMod.json() as {
    users: { id: string; balanceFcfa: number | null; email: string | null; phone: string | null; lastLoginAt: string | null }[];
  }).users;
  const awaAsMod = modList.find((u) => u.id === contributor.id)!;
  assert.equal(awaAsMod.balanceFcfa, null);
  assert.equal(awaAsMod.email, null);
  assert.equal(awaAsMod.phone, null);
  assert.equal(awaAsMod.lastLoginAt, null);

  // un admin (wallet.read) continue de tout voir
  const adminTk = await adminToken(app);
  const asAdmin = await app.inject({ method: 'GET', url: '/admin/users', headers: { authorization: `Bearer ${adminTk}` } });
  const adminList = (asAdmin.json() as { users: { id: string; balanceFcfa: number | null; email: string | null }[] }).users;
  const awaAsAdmin = adminList.find((u) => u.id === contributor.id)!;
  assert.equal(awaAsAdmin.balanceFcfa, 2500);
  assert.equal(awaAsAdmin.email, 'awa@x.bf');
});

test('login admin réussi écrit un événement audit login', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const tk = await adminToken(app);
  const audit = await app.inject({
    method: 'GET', url: '/admin/audit-log?action=login', headers: { authorization: `Bearer ${tk}` },
  });
  const entries = (audit.json() as { entries: { action: string; metadata?: { channel?: string } }[] }).entries;
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].metadata?.channel, 'admin');
});

test('admin suspendu entre /login et /totp → 403 ACCOUNT_DISABLED, aucun token', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);

  // Étape 1 : mot de passe OK → challenge émis (compte encore actif).
  const login = await app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email: 'admin@sabidata.bf', password: 'admin123' },
  });
  assert.equal(login.statusCode, 200);
  const { challenge } = login.json() as { challenge: string };

  // Suspension pendant la fenêtre (via repo direct : pas de garde-fou LAST_ADMIN).
  const admin = await repo.findUserByEmail('admin@sabidata.bf');
  await repo.updateUser(admin!.id, { status: 'suspended' });

  // Étape 2 : code TOTP valide → refus quand même, pas de token, pas d'audit login.
  const totp = await app.inject({
    method: 'POST', url: '/admin/auth/totp',
    payload: { challenge, code: currentTotp(DEV_TOTP_SECRET) },
  });
  assert.equal(totp.statusCode, 403);
  assert.match(totp.body, /ACCOUNT_DISABLED/);
  assert.equal((totp.json() as { access?: string }).access, undefined);
  const logins = await repo.listAudit({ action: 'login' });
  assert.equal(logins.length, 0);
});

test('retraits : file + décision motivée', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const u = await repo.createUser({ name: 'Ali', role: 'contributor', competence: 0, phone: '70000010', phoneVerified: true });
  const w = await repo.createWithdrawal({ userId: u.id, amountFcfa: 1500, provider: 'wave' });
  const app = buildServer(repo);
  const tk = await adminToken(app);
  const H = { authorization: `Bearer ${tk}` };

  const list = await app.inject({ method: 'GET', url: '/admin/withdrawals?status=processing', headers: H });
  assert.equal((list.json() as { withdrawals: unknown[] }).withdrawals.length, 1);

  const decide = await app.inject({
    method: 'POST', url: `/admin/withdrawals/${w.id}/decide`, headers: H,
    payload: { decision: 'approved', reason: 'virement effectué réf 123' },
  });
  assert.equal(decide.statusCode, 200);
  assert.equal((decide.json() as { status: string }).status, 'paid');
});

// /api/clips/:id/audio exige l'audience 'mobile' ; un token admin doit
// pouvoir écouter les clips en litige via une route dédiée /admin/clips/:id/audio.
test('GET /admin/clips/:id/audio — rejoue le flux audio pour un admin', async () => {
  const repo = new InMemoryRepo();
  const audioStore = new InMemoryAudioStore();
  await seedDevAdmin(repo);
  const contributor = await repo.createUser({ name: 'Awa', role: 'contributor', competence: 0, phone: '70000011', phoneVerified: true });
  const clip = await repo.createClip({
    contributorId: contributor.id,
    rarity: 1,
    durationS: 4,
    requiredCompetence: 1,
    status: 'disputed',
    consent: { commercialUse: true, consentVersion: 'v1', licenseTag: 'std', provenance: {} },
  });
  const audioPath = await audioStore.save(clip.id, Buffer.from('AUDIODATA'), 'm4a');
  await repo.setClipAudio(clip.id, audioPath);

  const app = buildServer(repo, audioStore);
  const tk = await adminToken(app);

  const res = await app.inject({
    method: 'GET', url: `/admin/clips/${clip.id}/audio`, headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.toString(), 'AUDIODATA');
  assert.match(res.headers['content-type'] as string, /audio\/mp4/);

  const missing = await app.inject({
    method: 'GET', url: '/admin/clips/nope/audio', headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(missing.statusCode, 404);
});
