import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, DEV_TOTP_SECRET, seedDevAdmin } from './server';
import { InMemoryRepo } from './ports/repo';
import { currentTotp } from './auth/totp';
import { resetRateLimits } from './http/rateLimit';

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

test('POST /admin/users/:id/password — hash, audit et révocation des sessions', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const H = { authorization: `Bearer ${await adminToken(app)}` };

  const created = await app.inject({
    method: 'POST', url: '/admin/users', headers: H,
    payload: {
      name: 'Awa Reset', email: 'awa.reset@sabidata.bf', role: 'contributor', password: 'ancien123',
    },
  });
  assert.equal(created.statusCode, 201);
  const { id } = created.json() as { id: string };

  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'awa.reset@sabidata.bf', password: 'ancien123' },
  });
  assert.equal(login.statusCode, 200);
  const oldAccess = (login.json() as { access: string }).access;
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${oldAccess}` } })).statusCode,
    200,
  );

  const noReason = await app.inject({
    method: 'POST', url: `/admin/users/${id}/password`, headers: H,
    payload: { password: 'nouveau123' },
  });
  assert.equal(noReason.statusCode, 400);
  assert.match(noReason.body, /REASON_REQUIRED/);

  const weak = await app.inject({
    method: 'POST', url: `/admin/users/${id}/password`, headers: H,
    payload: { password: '123', reason: 'demande utilisateur' },
  });
  assert.equal(weak.statusCode, 400);
  assert.match(weak.body, /WEAK_PASSWORD/);

  const reset = await app.inject({
    method: 'POST', url: `/admin/users/${id}/password`, headers: H,
    payload: { password: 'nouveau123', reason: 'demande utilisateur' },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal((reset.json() as { sessionsRevoked: boolean }).sessionsRevoked, true);

  // L'ancien access est immédiatement révoqué (token_version).
  const stale = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${oldAccess}` },
  });
  assert.equal(stale.statusCode, 401);
  assert.match(stale.body, /INVALID_TOKEN/);

  const oldPw = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'awa.reset@sabidata.bf', password: 'ancien123' },
  });
  assert.equal(oldPw.statusCode, 401);
  const newPw = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'awa.reset@sabidata.bf', password: 'nouveau123' },
  });
  assert.equal(newPw.statusCode, 200);

  const audit = await app.inject({
    method: 'GET', url: '/admin/audit-log?action=user.password_reset', headers: H,
  });
  const entries = (audit.json() as { entries: Array<{ entityId: string; reason: string }> }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.entityId, id);
  assert.equal(entries[0]?.reason, 'demande utilisateur');
});

test('référentiel — PATCH puis soft-delete langues/dialectes/prompts, 409 si utilisé', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const H = { authorization: `Bearer ${await adminToken(app)}` };

  const langRes = await app.inject({
    method: 'POST', url: '/admin/languages', headers: H,
    payload: { code: 'bwamu', nameFr: 'Bwamu', isoBcp47: 'bw' },
  });
  assert.equal(langRes.statusCode, 201);

  const diaRes = await app.inject({
    method: 'POST', url: '/admin/dialects', headers: H,
    payload: { languageCode: 'bwamu', code: 'sud', nameFr: 'Bwamu du Sud', zone: 'Hauts-Bassins' },
  });
  assert.equal(diaRes.statusCode, 201);
  const dialect = (diaRes.json() as { dialect: { id: string } }).dialect;

  const promptRes = await app.inject({
    method: 'POST', url: '/admin/prompts', headers: H,
    payload: {
      stableId: 'bwamu-sud-001', languageCode: 'bwamu', dialectCode: 'sud',
      text: 'Raconte ta journée.',
    },
  });
  assert.equal(promptRes.statusCode, 201);

  const patchLang = await app.inject({
    method: 'PATCH', url: '/admin/languages/bwamu', headers: H,
    payload: { nameFr: 'Bwamu (Bobo)', isoBcp47: 'bw' },
  });
  assert.equal(patchLang.statusCode, 200);
  assert.equal((patchLang.json() as { language: { nameFr: string } }).language.nameFr, 'Bwamu (Bobo)');

  const patchDia = await app.inject({
    method: 'PATCH', url: `/admin/dialects/${dialect.id}`, headers: H,
    payload: { nameFr: 'Bwamu sud', zone: null, targetHours: 12 },
  });
  assert.equal(patchDia.statusCode, 200);
  const patchedDia = (patchDia.json() as {
    dialect: { nameFr: string; zone?: string; targetHours: number };
  }).dialect;
  assert.equal(patchedDia.nameFr, 'Bwamu sud');
  assert.equal(patchedDia.zone, undefined);
  assert.equal(patchedDia.targetHours, 12);

  const patchPrompt = await app.inject({
    method: 'PATCH', url: '/admin/prompts/bwamu-sud-001', headers: H,
    payload: { text: 'Raconte ta matinée.' },
  });
  assert.equal(patchPrompt.statusCode, 200);
  assert.equal(
    (patchPrompt.json() as { prompt: { text: string } }).prompt.text,
    'Raconte ta matinée.',
  );

  // Encore utilisé par des enfants actifs → refus.
  const langBusy = await app.inject({
    method: 'DELETE', url: '/admin/languages/bwamu', headers: H,
  });
  assert.equal(langBusy.statusCode, 409);
  assert.match(langBusy.body, /REFERENCE_IN_USE/);

  const diaBusy = await app.inject({
    method: 'DELETE', url: `/admin/dialects/${dialect.id}`, headers: H,
  });
  assert.equal(diaBusy.statusCode, 409);
  assert.match(diaBusy.body, /REFERENCE_IN_USE/);

  // Feuille vers racine : prompt → dialecte → langue.
  const delPrompt = await app.inject({
    method: 'DELETE', url: '/admin/prompts/bwamu-sud-001', headers: H,
  });
  assert.equal(delPrompt.statusCode, 200);

  const delDia = await app.inject({
    method: 'DELETE', url: `/admin/dialects/${dialect.id}`, headers: H,
  });
  assert.equal(delDia.statusCode, 200);

  const delLang = await app.inject({
    method: 'DELETE', url: '/admin/languages/bwamu', headers: H,
  });
  assert.equal(delLang.statusCode, 200);

  // Les entités restent visibles en admin, marquées inactives.
  const langs = await app.inject({ method: 'GET', url: '/admin/languages', headers: H });
  assert.equal(
    (langs.json() as { languages: Array<{ code: string; status: string }> }).languages
      .find((l) => l.code === 'bwamu')?.status,
    'inactive',
  );
  const dias = await app.inject({ method: 'GET', url: '/admin/dialects', headers: H });
  assert.equal(
    (dias.json() as { dialects: Array<{ id: string; active?: boolean }> }).dialects
      .find((d) => d.id === dialect.id)?.active,
    false,
  );
  const prompts = await app.inject({ method: 'GET', url: '/admin/prompts', headers: H });
  assert.equal(
    (prompts.json() as { prompts: Array<{ stableId: string; active?: boolean }> }).prompts
      .find((p) => p.stableId === 'bwamu-sud-001')?.active,
    false,
  );

  // Suppression idempotente.
  const again = await app.inject({ method: 'DELETE', url: '/admin/languages/bwamu', headers: H });
  assert.equal(again.statusCode, 200);
});

test('référentiel — un prompt/clip existant bloque aussi la suppression', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const app = buildServer(repo);
  const H = { authorization: `Bearer ${await adminToken(app)}` };

  await repo.createLanguage({ code: 'gourmantche', nameFr: 'Gourmantché', isoBcp47: 'gu' });
  const dialect = await repo.createDialect({
    languageCode: 'gourmantche', code: 'est', nameFr: 'Gourmantché de l’Est',
  });
  await repo.createPrompt({
    stableId: 'gourmantche-est-001', languageCode: 'gourmantche',
    dialectCode: 'est', text: 'Parle de ton village.',
  });
  const awa = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0, phoneVerified: true,
    language: 'gourmantche', dialect: 'est',
  });
  await repo.createClip({
    contributorId: awa.id, promptId: 'gourmantche-est-001', rarity: 0, durationS: 4,
    requiredCompetence: 0, language: 'gourmantche', dialect: 'est', status: 'peer_review',
    consent: {
      commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {},
    },
  });

  const promptBusy = await app.inject({
    method: 'DELETE', url: '/admin/prompts/gourmantche-est-001', headers: H,
  });
  assert.equal(promptBusy.statusCode, 409);
  assert.match(promptBusy.body, /REFERENCE_IN_USE/);

  const diaBusy = await app.inject({
    method: 'DELETE', url: `/admin/dialects/${dialect.id}`, headers: H,
  });
  assert.equal(diaBusy.statusCode, 409);

  const langBusy = await app.inject({
    method: 'DELETE', url: '/admin/languages/gourmantche', headers: H,
  });
  assert.equal(langBusy.statusCode, 409);
});
