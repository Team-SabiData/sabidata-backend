import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { SupportService } from './services/supportService';
import { buildServer } from './server';
import { resetRateLimits } from './http/rateLimit';
import { type Principal } from './authz/can';

const consent = { commercialUse: true, consentVersion: 'v1', licenseTag: 'commercial-v1', provenance: {} };

function p(role: Principal['role'], id: string, audience: Principal['audience'] = 'mobile'): Principal {
  return { userId: id, role, competence: 1, audience };
}

async function register(app: ReturnType<typeof buildServer>, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: 'Awa', email, password: 'secret123' },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as { access: string; user: { id: string } };
}

test('support : une seule conversation ouverte, rattachable à un clip possédé', async () => {
  const repo = new InMemoryRepo();
  const svc = new SupportService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 1, phoneVerified: true });
  const bob = await repo.createUser({ name: 'Bob', role: 'contributor', competence: 1, phoneVerified: true });
  const clip = await repo.createClip({
    contributorId: alice.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    status: 'disputed', consent,
  });

  const a = await svc.openConversation(p('contributor', alice.id), { clipId: clip.id, subject: 'Litige' });
  const again = await svc.openConversation(p('contributor', alice.id), {});
  assert.equal(again.id, a.id);
  assert.equal(again.clipId, clip.id);

  await assert.rejects(
    () => svc.openConversation(p('contributor', bob.id), { clipId: clip.id }),
    /clip/,
  );
});

test('support : messages, polling after et cloisonnement utilisateur', async () => {
  const repo = new InMemoryRepo();
  const svc = new SupportService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 1, phoneVerified: true });
  const bob = await repo.createUser({ name: 'Bob', role: 'contributor', competence: 1, phoneVerified: true });
  const conv = await svc.openConversation(p('contributor', alice.id), {});
  const m1 = await svc.postMessage(p('contributor', alice.id), conv.id, 'Bonjour');
  await new Promise((r) => setTimeout(r, 5));
  const m2 = await svc.postMessage(p('contributor', alice.id), conv.id, 'Toujours là ?');

  const all = await svc.listMessages(p('contributor', alice.id), conv.id);
  assert.deepEqual(all.map((m) => m.body), ['Bonjour', 'Toujours là ?']);

  const after = await svc.listMessages(p('contributor', alice.id), conv.id, {
    after: m1.createdAt.toISOString(),
  });
  assert.deepEqual(after.map((m) => m.id), [m2.id]);

  await assert.rejects(() => svc.listMessages(p('contributor', bob.id), conv.id), /conversation/);
  await assert.rejects(() => svc.postMessage(p('contributor', bob.id), conv.id, 'intrusion'), /conversation/);
});

test('support : clôture puis nouvelle conversation, staff répond et clôt', async () => {
  const repo = new InMemoryRepo();
  const svc = new SupportService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 1, phoneVerified: true });
  const conv = await svc.openConversation(p('contributor', alice.id), {});
  const closed = await svc.close(p('contributor', alice.id), conv.id);
  assert.equal(closed.status, 'closed');

  const next = await svc.openConversation(p('contributor', alice.id), {});
  assert.notEqual(next.id, conv.id);

  const staff = p('moderator', 'staff-1', 'admin');
  const reply = await svc.postStaffMessage(staff, next.id, 'Bonjour, comment aider ?');
  assert.equal(reply.senderRole, 'staff');
  const got = await svc.getForStaff(staff, next.id);
  assert.equal(got.conversation.userName, 'Alice');
  assert.equal(got.messages.at(-1)?.body, 'Bonjour, comment aider ?');

  await assert.rejects(
    () => svc.listForStaff(p('contributor', alice.id), { status: 'open' }),
    /forbidden/,
  );
});

test('support HTTP : parcours mobile complet', async () => {
  const app = buildServer(new InMemoryRepo());
  const { access } = await register(app, 'chat@example.com');
  const H = { authorization: `Bearer ${access}` };

  const opened = await app.inject({
    method: 'POST', url: '/api/support/conversations', headers: H, payload: { subject: 'Aide' },
  });
  assert.equal(opened.statusCode, 201);
  const id = (opened.json() as { conversation: { id: string } }).conversation.id;

  const sent = await app.inject({
    method: 'POST', url: `/api/support/conversations/${id}/messages`, headers: H,
    payload: { body: 'Bonjour' },
  });
  assert.equal(sent.statusCode, 201);

  const current = await app.inject({ method: 'GET', url: '/api/support/conversation', headers: H });
  assert.equal(current.statusCode, 200);
  assert.equal((current.json() as { messages: unknown[] }).messages.length, 1);

  const closed = await app.inject({
    method: 'POST', url: `/api/support/conversations/${id}/close`, headers: H,
  });
  assert.equal(closed.statusCode, 200);
  assert.equal((closed.json() as { conversation: { status: string } }).conversation.status, 'closed');
});


test('support : non-lus, accusés de lecture et résumé litige', async () => {
  const repo = new InMemoryRepo();
  const svc = new SupportService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 1, phoneVerified: true });
  const clip = await repo.createClip({
    contributorId: alice.id, rarity: 0, durationS: 4, requiredCompetence: 0,
    status: 'disputed', consent,
  });
  const aliceP = p('contributor', alice.id);
  const staff = p('moderator', 'staff-1', 'admin');
  const conv = await svc.openConversation(aliceP, { clipId: clip.id });
  await svc.postMessage(aliceP, conv.id, 'Ma question');

  const summary = await svc.summaryForClip(clip.id);
  assert.equal(summary?.conversationId, conv.id);
  assert.equal(summary?.lastMessage?.body, 'Ma question');
  assert.equal(summary?.unreadForStaff, 1);

  const staffView = await svc.getForStaff(staff, conv.id);
  assert.equal(staffView.unreadForStaff, 1);
  const staffRead = await svc.markStaffRead(staff, conv.id);
  assert.equal(staffRead.unreadForStaff, 0);
  assert.equal((await svc.getForStaff(staff, conv.id)).unreadForStaff, 0);

  await svc.postStaffMessage(staff, conv.id, 'Réponse');
  const userView = await svc.getCurrent(aliceP);
  assert.equal(userView.unread, 1);
  const userRead = await svc.markRead(aliceP, conv.id);
  assert.equal(userRead.unread, 0);
  assert.equal((await svc.getCurrent(aliceP)).unread, 0);
});

test('support : pagination messages (latest, before, after)', async () => {
  const repo = new InMemoryRepo();
  const svc = new SupportService(repo);
  const alice = await repo.createUser({ name: 'Alice', role: 'contributor', competence: 1, phoneVerified: true });
  const aliceP = p('contributor', alice.id);
  const conv = await svc.openConversation(aliceP, {});
  const sent = [];
  for (let i = 1; i <= 5; i++) {
    sent.push(await svc.postMessage(aliceP, conv.id, `msg ${i}`));
    await new Promise((r) => setTimeout(r, 2));
  }

  const latest = await svc.listMessages(aliceP, conv.id, { limit: 2 });
  assert.deepEqual(latest.map((m) => m.body), ['msg 4', 'msg 5']);

  const before = await svc.listMessages(aliceP, conv.id, {
    before: sent[4].createdAt.toISOString(), limit: 2,
  });
  assert.deepEqual(before.map((m) => m.body), ['msg 3', 'msg 4']);

  const after = await svc.listMessages(aliceP, conv.id, {
    after: sent[1].createdAt.toISOString(), limit: 2,
  });
  assert.deepEqual(after.map((m) => m.body), ['msg 3', 'msg 4']);
});

test('support HTTP : rate-limit ouverture et lecture', async () => {
  resetRateLimits();
  const app = buildServer(new InMemoryRepo());
  const { access } = await register(app, 'ratelimit@example.com');
  const H = { authorization: `Bearer ${access}` };

  let id = '';
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/support/conversations', headers: H, payload: {},
    });
    assert.equal(res.statusCode, 201);
    id = (res.json() as { conversation: { id: string } }).conversation.id;
  }
  const blocked = await app.inject({
    method: 'POST', url: '/api/support/conversations', headers: H, payload: {},
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'] !== undefined, true);

  const read = await app.inject({
    method: 'POST', url: `/api/support/conversations/${id}/read`, headers: H,
  });
  assert.equal(read.statusCode, 200);
  assert.equal((read.json() as { unread: number }).unread, 0);

  for (let i = 0; i < 20; i++) {
    const sent = await app.inject({
      method: 'POST', url: `/api/support/conversations/${id}/messages`, headers: H,
      payload: { body: `message ${i}` },
    });
    assert.equal(sent.statusCode, 201);
  }
  const blockedMessage = await app.inject({
    method: 'POST', url: `/api/support/conversations/${id}/messages`, headers: H,
    payload: { body: 'trop' },
  });
  assert.equal(blockedMessage.statusCode, 429);
});
