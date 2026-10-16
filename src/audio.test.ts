import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRepo } from './ports/repo';
import { FsAudioStore } from './storage/audioStore';
import { buildServer } from './server';

// Construit un corps multipart/form-data minimal (sans dépendance externe).
function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Buffer },
) {
  const boundary = '----sabidata' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Inscrit un utilisateur mobile et renvoie {app, token, repo, store}.
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-audio-'));
  const repo = new InMemoryRepo();
  const store = new FsAudioStore(dir);
  const app = buildServer(repo, store);
  await app.ready();
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: 'Alice', email: `a${Math.random()}@x.bf`, password: 'secret1' },
  });
  const token = JSON.parse(reg.body).access as string;
  return { app, token, repo, store, dir };
}

test('classroom — création + join par code + stats de groupe', async () => {
  const repo = new InMemoryRepo();
  const dir = mkdtempSync(join(tmpdir(), 'sabi-cls-'));
  const app = buildServer(repo, new FsAudioStore(dir));
  await app.ready();
  try {
    const regA = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'Prof', email: `p${Math.random()}@x.bf`, password: 'secret1' },
    });
    const tokA = JSON.parse(regA.body).access as string;
    const created = await app.inject({
      method: 'POST', url: '/api/classrooms',
      headers: { authorization: `Bearer ${tokA}` },
      payload: { name: 'École Mooré', description: 'Collecte Mooré' },
    });
    assert.equal(created.statusCode, 201);
    const cls = JSON.parse(created.body).classroom;
    assert.equal(cls.isOwner, true);
    assert.equal(cls.memberCount, 1);
    assert.equal((cls.inviteCode as string).length, 6);

    // B rejoint via le code → memberCount 2
    const regB = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'Élève', email: `e${Math.random()}@x.bf`, password: 'secret1' },
    });
    const tokB = JSON.parse(regB.body).access as string;
    const joined = await app.inject({
      method: 'POST', url: '/api/classrooms/join',
      headers: { authorization: `Bearer ${tokB}` }, payload: { code: cls.inviteCode },
    });
    assert.equal(joined.statusCode, 200);
    assert.equal(JSON.parse(joined.body).classroom.memberCount, 2);

    // code invalide → 404
    const bad = await app.inject({
      method: 'POST', url: '/api/classrooms/join',
      headers: { authorization: `Bearer ${tokB}` }, payload: { code: 'ZZZZZZ' },
    });
    assert.equal(bad.statusCode, 404);

    // GET mine (B) → son classroom, 2 membres
    const mine = await app.inject({ method: 'GET', url: '/api/classrooms/mine', headers: { authorization: `Bearer ${tokB}` } });
    assert.equal(mine.statusCode, 200);
    assert.equal(JSON.parse(mine.body).classroom.memberCount, 2);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classroom join — rate-limit anti-énumération (429 après trop de tentatives)', async () => {
  const repo = new InMemoryRepo();
  const dir = mkdtempSync(join(tmpdir(), 'sabi-rl-'));
  const app = buildServer(repo, new FsAudioStore(dir));
  await app.ready();
  try {
    const reg = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'Xavier', email: `x${Math.random()}@x.bf`, password: 'secret1' },
    });
    const tok = JSON.parse(reg.body).access as string;
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/classrooms/join',
        headers: { authorization: `Bearer ${tok}` }, payload: { code: 'ZZZZZZ' },
      });
      last = r.statusCode;
    }
    assert.equal(last, 429); // dépasse JOIN_MAX (8) sur la fenêtre
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh — access renouvelé via refresh token ; refresh invalide → 401', async () => {
  const repo = new InMemoryRepo();
  const dir = mkdtempSync(join(tmpdir(), 'sabi-rt-'));
  const app = buildServer(repo, new FsAudioStore(dir));
  await app.ready();
  try {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Ben', email: `b${Math.random()}@x.bf`, password: 'secret1' },
    });
    const refresh = JSON.parse(reg.body).refresh as string;
    assert.ok(refresh, 'register renvoie un refresh token');

    // refresh valide → nouvel access utilisable sur /api/me
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh } });
    assert.equal(r.statusCode, 200);
    const access = JSON.parse(r.body).access as string;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${access}` } });
    assert.equal(me.statusCode, 200);

    // refresh invalide → 401
    const bad = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh: 'garbage' } });
    assert.equal(bad.statusCode, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const goodFields = { rarity: '1', durationS: '4', commercialUse: 'true', consentVersion: 'v1' };

test('POST /api/clips multipart — 201, stocke l\'audio, audioPath renseigné', async () => {
  const { app, token, repo, dir } = await setup();
  try {
    const mp = multipart(goodFields, { field: 'audio', filename: 'c.m4a', contentType: 'audio/mp4', data: Buffer.from('AUDIODATA') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      payload: mp.body,
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'peer_review');
    const clip = await repo.getClip(body.clipId);
    assert.equal(clip?.audioPath, `${body.clipId}.m4a`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/clips multipart — mimetype non audio → 415', async () => {
  const { app, token, dir } = await setup();
  try {
    const mp = multipart(goodFields, { field: 'audio', filename: 'c.png', contentType: 'image/png', data: Buffer.from('X') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      payload: mp.body,
    });
    assert.equal(res.statusCode, 415);
    assert.equal(JSON.parse(res.body).error.code, 'BAD_FORMAT');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/clips multipart — fichier > 10 Mo → 413', async () => {
  const { app, token, dir } = await setup();
  try {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 1);
    const mp = multipart(goodFields, { field: 'audio', filename: 'big.m4a', contentType: 'audio/mp4', data: big });
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      payload: mp.body,
    });
    assert.equal(res.statusCode, 413);
    assert.equal(JSON.parse(res.body).error.code, 'TOO_LARGE');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/clips multipart — sans fichier audio → 400', async () => {
  const { app, token, dir } = await setup();
  try {
    const boundary = '----sabidataNoFile';
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(goodFields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'NO_AUDIO');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/clips/:id/audio — renvoie les octets stockés', async () => {
  const { app, token, dir } = await setup();
  try {
    const mp = multipart(goodFields, { field: 'audio', filename: 'c.m4a', contentType: 'audio/mp4', data: Buffer.from('AUDIODATA') });
    const post = await app.inject({
      method: 'POST', url: '/api/clips',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      payload: mp.body,
    });
    const clipId = JSON.parse(post.body).clipId as string;
    const res = await app.inject({
      method: 'GET', url: `/api/clips/${clipId}/audio`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.rawPayload.toString(), 'AUDIODATA');
    assert.match(res.headers['content-type'] as string, /audio\/mp4/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/clips/:id/audio — clip inexistant → 404', async () => {
  const { app, token, dir } = await setup();
  try {
    const res = await app.inject({
      method: 'GET', url: '/api/clips/nope/audio',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/me/profile — corps invalide (dialect/region/commercialConsent manquants) → 400', async () => {
  const { app, token, dir } = await setup();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/profile',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { language: 'Mooré' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'BAD_INPUT');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/me/profile — corps valide → 200, profileComplete: true', async () => {
  const { app, token, dir } = await setup();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/profile',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { language: 'Mooré', dialect: 'Yatenga', region: 'Nord', commercialConsent: true },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.profileComplete, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/validation/next — inclut audioUrl pour un clip en peer_review', async () => {
  const { app, token, repo, dir } = await setup();
  try {
    // Alice soumet ; Bob (validateur) reçoit le clip à valider.
    const mp = multipart(goodFields, { field: 'audio', filename: 'c.m4a', contentType: 'audio/mp4', data: Buffer.from('AUDIODATA') });
    await app.inject({
      method: 'POST', url: '/api/clips',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      payload: mp.body,
    });
    const email = `b${Math.random()}@x.bf`;
    const reg = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'Bob', email, password: 'secret1' },
    });
    // Un inscrit est contributor/compétence 0 → promotion puis re-login pour
    // obtenir un token portant les nouveaux claims.
    const bobId = JSON.parse(reg.body).user.id as string;
    await repo.updateUser(bobId, { role: 'validator', competence: 1 });
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email, password: 'secret1' },
    });
    const bob = JSON.parse(login.body).access as string;
    const res = await app.inject({
      method: 'GET', url: '/api/validation/next',
      headers: { authorization: `Bearer ${bob}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.audioUrl, `/api/clips/${body.clipId}/audio`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
