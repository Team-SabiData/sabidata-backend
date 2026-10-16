import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './auth/crypto';
import { generateTotpSecret, verifyTotp, currentTotp } from './auth/totp';
import { buildServer, seedDevAdmin } from './server';
import { InMemoryRepo } from './ports/repo';
import { verifyAccess } from './auth/jwt';

// — mot de passe : argon2id salé —
test('crypto — un mot de passe correct se vérifie, un mauvais échoue', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('mauvais', stored), false);
});

test('crypto — deux hachages du même mot de passe diffèrent (sel aléatoire)', () => {
  assert.notEqual(hashPassword('même'), hashPassword('même'));
});

test('crypto — un hash corrompu ne valide jamais', () => {
  assert.equal(verifyPassword('x', 'pas-un-hash'), false);
});

// — TOTP réel —
test('totp — le code courant valide, un code arbitraire échoue', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp(secret, currentTotp(secret)), true);
  assert.equal(verifyTotp(secret, '000000'), false);
});

// — escalade de privilège : un moderator ne doit JAMAIS recevoir un token role=admin —
async function makeServer() {
  const repo = new InMemoryRepo();
  const secret = generateTotpSecret();
  await repo.createUser({
    name: 'Mod', role: 'moderator', competence: 2, email: 'mod@sabidata.bf',
    passwordHash: hashPassword('modpass'), phoneVerified: true, totpSecret: secret,
  });
  return { app: buildServer(repo), repo, secret };
}

test('admin-auth — le token d\'un moderator porte role=moderator (pas admin)', async () => {
  const { app, secret } = await makeServer();
  const login = await app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email: 'mod@sabidata.bf', password: 'modpass' },
  });
  assert.equal(login.statusCode, 200);
  const { challenge } = login.json() as { challenge: string };

  const totp = await app.inject({
    method: 'POST', url: '/admin/auth/totp',
    payload: { challenge, code: currentTotp(secret) },
  });
  assert.equal(totp.statusCode, 200);
  const { access } = totp.json() as { access: string };
  const claims = verifyAccess(access, 'admin');
  assert.equal(claims.role, 'moderator'); // le bug signait 'admin' en dur
  assert.equal(claims.competence, 2);
});

test('admin-auth — mauvais mot de passe → 401, aucun challenge', async () => {
  const { app } = await makeServer();
  const r = await app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email: 'mod@sabidata.bf', password: 'mauvais-mdp' },
  });
  assert.equal(r.statusCode, 401);
});

test('admin-auth — mauvais code TOTP → 401', async () => {
  const { app } = await makeServer();
  const login = await app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email: 'mod@sabidata.bf', password: 'modpass' },
  });
  const { challenge } = login.json() as { challenge: string };
  const totp = await app.inject({
    method: 'POST', url: '/admin/auth/totp', payload: { challenge, code: '000000' },
  });
  assert.equal(totp.statusCode, 401);
});

test('admin-auth — l\'admin de dev se connecte avec un mot de passe haché', async () => {
  const repo = new InMemoryRepo();
  await seedDevAdmin(repo);
  const admin = await repo.findUserByEmail('admin@sabidata.bf');
  assert.ok(admin?.passwordHash && admin.passwordHash !== 'admin123'); // plus en clair
  assert.equal(verifyPassword('admin123', admin!.passwordHash!), true);
});
