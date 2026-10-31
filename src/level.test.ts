import { test } from 'node:test';
import assert from 'node:assert';
import {
  levelFor,
  meetsWithdrawLevel,
  countValidatedContributions,
  earnedPoints,
  convertiblePoints,
} from './domain/level';
import { type LedgerEntry } from './domain/contribution';
import { WalletService } from './services/walletService';
import { InMemoryRepo } from './ports/repo';

test('levelFor : frontières des paliers (points cumulés gagnés)', () => {
  assert.equal(levelFor(0), 'none');
  assert.equal(levelFor(499), 'none');
  assert.equal(levelFor(500), 'bronze');
  assert.equal(levelFor(1499), 'bronze');
  assert.equal(levelFor(1500), 'argent');
  assert.equal(levelFor(4499), 'argent');
  assert.equal(levelFor(4500), 'or');
});

test('meetsWithdrawLevel : seule la conversion OR est autorisée', () => {
  assert.equal(meetsWithdrawLevel('none'), false);
  assert.equal(meetsWithdrawLevel('bronze'), false);
  assert.equal(meetsWithdrawLevel('argent'), false);
  assert.equal(meetsWithdrawLevel('or'), true);
});

test('earnedPoints : gains confirmés uniquement', () => {
  const led = (reason: string, state: string, delta = 10): LedgerEntry =>
    ({ id: 'x', userId: 'u', delta, reason: reason as never, state: state as never });
  const ledger = [
    led('record', 'confirmed', 4500),
    led('validate', 'confirmed', 10),
    led('record', 'provisional', 500),
    led('withdrawal_refund', 'confirmed', 50),
    led('admin_adjustment', 'confirmed', -100),
  ];
  assert.equal(earnedPoints(ledger), 4510);
});

test('convertiblePoints : seuls les points gagnés APRÈS OR, retraits déduits', () => {
  const led = (reason: string, delta: number): LedgerEntry =>
    ({ id: 'x', userId: 'u', delta, reason: reason as never, state: 'confirmed' });
  const ledger = [
    led('record', 4500), // atteint OR, non convertible
    led('record', 1000), // gagné après OR → convertible
    led('withdrawal', -500),
    led('withdrawal_refund', 200),
  ];
  assert.equal(convertiblePoints(ledger), 700);

  // Un gain unique qui franchit OR : seule la fraction au-dessus est convertible.
  const crossing = [led('record', 5000)];
  assert.equal(convertiblePoints(crossing), 500);
});

test('countValidatedContributions : ne compte que les entrées confirmées contributives', () => {
  const led = (reason: string, state: string): LedgerEntry =>
    ({ id: 'x', userId: 'u', delta: 10, reason: reason as never, state: state as never });
  const ledger = [
    led('record', 'confirmed'),
    led('validate', 'confirmed'),
    led('transcribe', 'confirmed'),
    led('record', 'provisional'),
    led('withdrawal', 'confirmed'),
  ];
  assert.equal(countValidatedContributions(ledger), 3);
});

test('getWallet : grade sur points cumulés, conversion limitée à l’après-OR', async () => {
  const repo = new InMemoryRepo();
  const u = await repo.createUser({ name: 'Aïcha', role: 'contributor', competence: 1, phoneVerified: true });
  await repo.addLedger({ userId: u.id, delta: 4500, reason: 'record', state: 'confirmed' });
  await repo.addLedger({ userId: u.id, delta: 1000, reason: 'record', state: 'confirmed' });
  const w = await new WalletService(repo).getWallet(u.id);
  assert.equal(w.pointsEarned, 5500);
  assert.equal(w.level, 'or');
  assert.equal(w.pointsConvertible, 1000);
  assert.equal(w.balanceFcfa, 150);
  assert.equal(w.contributionsValidated, 2);
});
