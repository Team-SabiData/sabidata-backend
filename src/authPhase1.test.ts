import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { buildServer } from './server';
import { hashOtp } from './auth/otp';

async function register(app: ReturnType<typeof buildServer>, email: string, phone?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: 'Awa', email, phone, password: 'secret123' },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as { access: string; refresh: string; user: { id: string; permissions: string[] } };
}

test('/api/me expose les permissions et le verrou de profil', async () => {
  const app = buildServer(new InMemoryRepo());
  const { access, user } = await register(app, 'awa@example.com');
  assert.deepEqual(user.permissions.sort(), ['contribute', 'transcribe']);

  const before = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${access}` },
  });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().profileLocked, false);

  const set = await app.inject({
    method: 'POST', url: '/api/me/profile',
    headers: { authorization: `Bearer ${access}` },
    payload: { language: 'Mooré', dialect: 'Yatenga', region: 'Nord', commercialConsent: true },
  });
  assert.equal(set.statusCode, 200);

  const locked = await app.inject({
    method: 'POST', url: '/api/me/profile',
    headers: { authorization: `Bearer ${access}` },
    payload: { language: 'Dioula', dialect: 'Bobo', region: 'Hauts-Bassins', commercialConsent: true },
  });
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.json().error.code, 'PROFILE_LOCKED');

  const same = await app.inject({
    method: 'POST', url: '/api/me/profile',
    headers: { authorization: `Bearer ${access}` },
    payload: { language: 'Mooré', dialect: 'Yatenga', region: 'Nord', commercialConsent: false },
  });
  assert.equal(same.statusCode, 200);
});

test('logout révoque access ET refresh tokens', async () => {
  const app = buildServer(new InMemoryRepo());
  const { access, refresh } = await register(app, 'revoke@example.com');

  const out = await app.inject({
    method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${access}` },
  });
  assert.equal(out.statusCode, 200);

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${access}` },
  });
  assert.equal(me.statusCode, 401);

  const renewed = await app.inject({
    method: 'POST', url: '/api/auth/refresh', payload: { refresh },
  });
  assert.equal(renewed.statusCode, 401);
  assert.equal(renewed.json().error.code, 'INVALID_REFRESH');
});

test('changement de téléphone : demande puis confirmation OTP', async () => {
  const repo = new InMemoryRepo();
  const app = buildServer(repo);
  const { access, user } = await register(app, 'contact@example.com', '70000001');

  const req = await app.inject({
    method: 'POST', url: '/api/me/contact',
    headers: { authorization: `Bearer ${access}` },
    payload: { phone: '70000002' },
  });
  assert.equal(req.statusCode, 202);
  assert.match(req.json().sentTo, /^700\*\*\*\*02$/);

  // Le code réel n'est pas exposé par l'API : on remplace le challenge par un
  // code connu pour tester la confirmation.
  await repo.deleteContactChangesForUser(user.id);
  const challenge = await repo.createContactChange({
    userId: user.id,
    newPhone: '70000002',
    verifyPhone: '70000002',
    codeHash: hashOtp('123456'),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const bad = await app.inject({
    method: 'POST', url: '/api/me/contact/confirm',
    headers: { authorization: `Bearer ${access}` },
    payload: { challengeId: challenge.id, code: '000000' },
  });
  assert.equal(bad.statusCode, 401);

  const ok = await app.inject({
    method: 'POST', url: '/api/me/contact/confirm',
    headers: { authorization: `Bearer ${access}` },
    payload: { challengeId: challenge.id, code: '123456' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().phone, '70000002');
  assert.equal(ok.json().phoneVerified, true);
});

test('RBAC routes : un contributeur ne peut pas valider une transcription', async () => {
  const app = buildServer(new InMemoryRepo());
  const { access } = await register(app, 'rbac@example.com');
  const res = await app.inject({
    method: 'POST', url: '/api/transcriptions/inconnue/validations',
    headers: { authorization: `Bearer ${access}` },
    payload: { verdict: 'correct' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});

test('leaderboard : langue + dialecte obligatoires, points gagnés filtrés', async () => {
  const repo = new InMemoryRepo();
  const app = buildServer(repo);
  const awa = await register(app, 'leader-a@example.com');
  const ben = await register(app, 'leader-b@example.com');
  await repo.updateUser(awa.user.id, { language: 'Mooré', dialect: 'Yatenga', region: 'Nord' });
  await repo.updateUser(ben.user.id, { language: 'Dioula', dialect: 'Bobo', region: 'Hauts-Bassins' });
  await repo.addLedger({ userId: awa.user.id, delta: 5000, reason: 'record', state: 'confirmed' });
  await repo.addLedger({ userId: ben.user.id, delta: 9000, reason: 'record', state: 'confirmed' });

  const missing = await app.inject({
    method: 'GET', url: '/api/leaderboard', headers: { authorization: `Bearer ${awa.access}` },
  });
  assert.equal(missing.statusCode, 400);

  const res = await app.inject({
    method: 'GET', url: '/api/leaderboard?lang=Moor%C3%A9&dialect=Yatenga',
    headers: { authorization: `Bearer ${awa.access}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { top10: { id: string; points: number }[]; me: { id: string } };
  assert.equal(body.top10.length, 1);
  assert.equal(body.top10[0]!.id, awa.user.id);
  assert.equal(body.top10[0]!.points, 5000);
  assert.equal(body.me.id, awa.user.id);
});
