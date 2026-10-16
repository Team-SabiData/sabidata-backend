import { test } from 'node:test';
import assert from 'node:assert';
import { levelFor, meetsWithdrawLevel, countValidatedContributions } from './domain/level';
import { type LedgerEntry } from './domain/contribution';
import { WalletService } from './services/walletService';
import { InMemoryRepo } from './ports/repo';

test('levelFor : frontières des paliers', () => {
  assert.equal(levelFor(0), 'bronze');
  assert.equal(levelFor(49), 'bronze');
  assert.equal(levelFor(50), 'argent');
  assert.equal(levelFor(199), 'argent');
  assert.equal(levelFor(200), 'or');
});

test('meetsWithdrawLevel : Bronze bloqué, Argent et Or autorisés', () => {
  assert.equal(meetsWithdrawLevel('bronze'), false);
  assert.equal(meetsWithdrawLevel('argent'), true);
  assert.equal(meetsWithdrawLevel('or'), true);
});

test('countValidatedContributions : ne compte que les entrées confirmées contributives', () => {
  const led = (reason: string, state: string): LedgerEntry =>
    ({ id: 'x', userId: 'u', delta: 10, reason: reason as never, state: state as never });
  const ledger = [
    led('record', 'confirmed'),      // +1
    led('validate', 'confirmed'),    // +1
    led('transcribe', 'confirmed'),  // +1
    led('record', 'provisional'),    // exclu (non confirmé)
    led('withdrawal', 'confirmed'),  // exclu (non contributif)
  ];
  assert.equal(countValidatedContributions(ledger), 3);
});

test('getWallet : renvoie contributionsValidated et level', async () => {
  const repo = new InMemoryRepo();
  const u = await repo.createUser({ name: 'Aïcha', role: 'contributor', competence: 1, phoneVerified: true });
  for (let i = 0; i < 50; i++) {
    await repo.addLedger({ userId: u.id, delta: 10, reason: 'validate', state: 'confirmed' });
  }
  const w = await new WalletService(repo).getWallet(u.id);
  assert.equal(w.contributionsValidated, 50);
  assert.equal(w.level, 'argent');
});
