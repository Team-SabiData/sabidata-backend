import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';

test('updateUser applique status et anonymisation', async () => {
  const repo = new InMemoryRepo();
  const u = await repo.createUser({
    name: 'Awa', role: 'contributor', competence: 0,
    phone: '70000001', phoneVerified: true,
  });
  await repo.updateUser(u.id, { status: 'suspended' });
  assert.equal((await repo.findUserById(u.id))?.status, 'suspended');

  await repo.updateUser(u.id, { status: 'deleted', name: 'Utilisateur supprimé', email: null, phone: null });
  const del = await repo.findUserById(u.id);
  assert.equal(del?.status, 'deleted');
  assert.equal(del?.name, 'Utilisateur supprimé');
  assert.equal(del?.phone, undefined);
});

test('retraits : create → list par statut → décision', async () => {
  const repo = new InMemoryRepo();
  const u = await repo.createUser({ name: 'Ali', role: 'contributor', competence: 0, phone: '70000002', phoneVerified: true });
  const w = await repo.createWithdrawal({ userId: u.id, amountFcfa: 1000, provider: 'orange_money' });
  assert.equal(w.status, 'processing');
  assert.equal((await repo.listWithdrawals('processing')).length, 1);
  await repo.setWithdrawalStatus(w.id, 'paid');
  assert.equal((await repo.getWithdrawal(w.id))?.status, 'paid');
  assert.equal((await repo.listWithdrawals('processing')).length, 0);
});

test('listAudit filtre par action', async () => {
  const repo = new InMemoryRepo();
  await repo.addAudit({ actorId: 'u1', action: 'login', entityType: 'user', entityId: 'u1', reason: '', metadata: { channel: 'mobile' } });
  await repo.addAudit({ actorId: 'u1', action: 'user.update', entityType: 'user', entityId: 'u2', reason: 'x' });
  assert.equal((await repo.listAudit({ action: 'login' })).length, 1);
});
