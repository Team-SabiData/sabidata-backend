import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from './ports/repo';
import { AdminService } from './services/adminService';
import { WalletService } from './services/walletService';
import { type Principal } from './authz/can';

const admin = (id = 'adm'): Principal => ({ userId: id, role: 'admin', competence: 3, audience: 'admin' });

async function seed(repo: InMemoryRepo) {
  const a = await repo.createUser({ name: 'Root', role: 'admin', competence: 3, email: 'root@x.bf', phoneVerified: true });
  const u = await repo.createUser({ name: 'Awa', role: 'contributor', competence: 0, phone: '70000001', phoneVerified: true });
  return { a, u };
}

test('setUserStatus exige un motif et journalise', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  const svc = new AdminService(repo);
  await assert.rejects(svc.setUserStatus(admin(a.id), u.id, 'suspended', '  '), /REASON_REQUIRED/);
  await svc.setUserStatus(admin(a.id), u.id, 'banned', 'fraude avérée');
  assert.equal((await repo.findUserById(u.id))?.status, 'banned');
  const audit = await repo.listAudit({ action: 'user.status' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, 'fraude avérée');
});

test('garde-fous : pas sur soi-même, jamais le dernier admin', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  const svc = new AdminService(repo);
  await assert.rejects(svc.setUserStatus(admin(a.id), a.id, 'banned', 'x'), /SELF_FORBIDDEN/);
  await assert.rejects(svc.deleteUser(admin(a.id), a.id, 'x'), /SELF_FORBIDDEN/);
  // a est le seul admin : un 2e admin le bannit ? Non — un seul admin restant est protégé
  const b = await repo.createUser({ name: 'Adm2', role: 'admin', competence: 3, email: 'b@x.bf', phoneVerified: true });
  await svc.setUserStatus(admin(b.id), a.id, 'banned', 'compromis'); // ok : il reste b
  await assert.rejects(svc.setUserStatus(admin(a.id), b.id, 'banned', 'x'), /LAST_ADMIN/);
  void u;
});

test('réactiver un admin suspendu ne déclenche plus LAST_ADMIN', async () => {
  const repo = new InMemoryRepo();
  const { a } = await seed(repo);
  const svc = new AdminService(repo);
  const b = await repo.createUser({ name: 'Adm2', role: 'admin', competence: 3, email: 'b@x.bf', phoneVerified: true });
  await svc.setUserStatus(admin(a.id), b.id, 'suspended', 'vérification en cours');
  // à ce stade seul a est admin actif ; réactiver b ne compte pas comme "retirer" un admin actif
  const r = await svc.setUserStatus(admin(a.id), b.id, 'active', 'vérification terminée');
  assert.equal(r.status, 'active');
  assert.equal((await repo.findUserById(b.id))?.status, 'active');
});

test('deleteUser anonymise mais garde le ledger', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  await repo.addLedger({ userId: u.id, delta: 100, reason: 'record', state: 'confirmed' });
  const svc = new AdminService(repo);
  await svc.deleteUser(admin(a.id), u.id, 'demande RGPD');
  const del = await repo.findUserById(u.id);
  assert.equal(del?.status, 'deleted');
  assert.equal(del?.name, 'Utilisateur supprimé');
  assert.equal(del?.phone, undefined);
  assert.equal((await repo.ledgerFor(u.id)).length, 1); // le ledger reste
});

test('adjustBalance : ligne append-only signée + refus sur supprimé', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  const svc = new AdminService(repo);
  await assert.rejects(svc.adjustBalance(admin(a.id), u.id, 0, 'x'), /BAD_DELTA/);
  const r = await svc.adjustBalance(admin(a.id), u.id, 500, 'bonus campagne');
  assert.equal(r.pointsTotal, 500);
  const lines = await repo.ledgerFor(u.id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'admin_adjustment');
  assert.equal(lines[0].state, 'confirmed');
  await svc.deleteUser(admin(a.id), u.id, 'x');
  await assert.rejects(svc.adjustBalance(admin(a.id), u.id, 10, 'y'), /USER_DELETED/);
});

test('changeRole : motif requis, anti-lockout, self non-rétrogradant permis, audit journalisé', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  const svc = new AdminService(repo);

  // sans motif → REASON_REQUIRED
  await assert.rejects(svc.changeRole(admin(a.id), u.id, { role: 'validator' }, ''), /REASON_REQUIRED/);

  // se rétrograder soi-même → SELF_FORBIDDEN
  await assert.rejects(svc.changeRole(admin(a.id), a.id, { role: 'validator' }, 'x'), /SELF_FORBIDDEN/);

  // dernier admin actif protégé même via un changement de rôle
  const b = await repo.createUser({ name: 'Adm2', role: 'admin', competence: 3, email: 'b@x.bf', phoneVerified: true });
  await svc.setUserStatus(admin(b.id), a.id, 'banned', 'compromis'); // seul b reste admin actif
  await assert.rejects(svc.changeRole(admin(a.id), b.id, { role: 'validator' }, 'x'), /LAST_ADMIN/);

  // self-change NON rétrogradant (ajuster sa propre compétence) reste permis
  const self = await svc.changeRole(admin(b.id), b.id, { competence: 2 }, 'ajustement compétence');
  assert.equal(self.competence, 2);

  // promotion valide avec motif → audit user.update non vide
  const r = await svc.changeRole(admin(b.id), u.id, { role: 'validator', competence: 1 }, 'montée en compétence');
  assert.equal(r.role, 'validator');
  assert.equal(r.competence, 1);
  const audit = await repo.listAudit({ action: 'user.update' });
  assert.equal(audit.length, 2); // le self-change + la promotion
  assert.ok(audit.every((e) => (e.reason ?? '').trim().length > 0));
  assert.equal(audit[1].reason, 'montée en compétence');
});

test('decideWithdrawal : rejet re-crédite, double décision refusée', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  const svc = new AdminService(repo);
  const w = await repo.createWithdrawal({ userId: u.id, amountFcfa: 1000, provider: 'orange_money' });
  const r = await svc.decideWithdrawal(admin(a.id), w.id, 'rejected', 'numéro invalide');
  assert.equal(r.status, 'failed');
  const lines = await repo.ledgerFor(u.id);
  assert.equal(lines[0].reason, 'withdrawal_refund');
  assert.equal(lines[0].delta, 200); // 1000 FCFA / 5 (pointToFcfa) = 200 pts
  await assert.rejects(svc.decideWithdrawal(admin(a.id), w.id, 'approved', 'x'), /ALREADY_DECIDED/);
});

test('WalletService.requestWithdrawal : débite à la création, bout-en-bout avec decideWithdrawal', async () => {
  const repo = new InMemoryRepo();
  const { a, u } = await seed(repo);
  const svc = new AdminService(repo);
  const wallet = new WalletService(repo);
  // 50 contributions validées confirmées → niveau Argent, 500 pts (2500 FCFA)
  for (let i = 0; i < 50; i++) {
    await repo.addLedger({ userId: u.id, delta: 10, reason: 'validate', state: 'confirmed' });
  }

  // montant sous le minimum → BAD_AMOUNT
  await assert.rejects(wallet.requestWithdrawal(u.id, 100, 'orange_money'), /BAD_AMOUNT/);
  // montant au-delà du solde retirable → INSUFFICIENT_FUNDS
  await assert.rejects(wallet.requestWithdrawal(u.id, 100000, 'orange_money'), /INSUFFICIENT_FUNDS/);

  // création : débite immédiatement (1000 FCFA = 200 pts)
  const w = await wallet.requestWithdrawal(u.id, 1000, 'orange_money');
  let ledger = await repo.ledgerFor(u.id);
  let confirmed = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
  assert.equal(confirmed, 300); // 500 - 200

  // approve → solde reste débité (pas de nouvelle écriture)
  const approved = await svc.decideWithdrawal(admin(a.id), w.id, 'approved', 'virement effectué');
  assert.equal(approved.status, 'paid');
  ledger = await repo.ledgerFor(u.id);
  confirmed = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
  assert.equal(confirmed, 300);

  // second retrait, rejeté cette fois → re-crédit ramène le solde net à l'identique
  const w2 = await wallet.requestWithdrawal(u.id, 500, 'wave');
  const rejected = await svc.decideWithdrawal(admin(a.id), w2.id, 'rejected', 'numéro invalide');
  assert.equal(rejected.status, 'failed');
  ledger = await repo.ledgerFor(u.id);
  confirmed = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
  assert.equal(confirmed, 300); // débit de 100 pts puis re-crédit de 100 pts → net inchangé
});

test('WalletService.requestWithdrawal : refuse en Bronze (< 50 contributions)', async () => {
  const repo = new InMemoryRepo();
  const { u } = await seed(repo);
  const wallet = new WalletService(repo);
  // 1 seule contribution confirmée mais gros solde → Bronze, doit être bloqué
  await repo.addLedger({ userId: u.id, delta: 1000, reason: 'record', state: 'confirmed' });
  await assert.rejects(wallet.requestWithdrawal(u.id, 1000, 'orange_money'), /LEVEL_TOO_LOW/);
});
