import { test } from 'node:test';
import assert from 'node:assert';
import { InMemoryRepo } from './ports/repo';
import { isProfileComplete, ProfileReq } from './mobile/profileSchema';
import { buildRegionCoverage } from './mobile/regionCoverage';

test('updateUser : persiste language/dialect/region/commercialConsent', async () => {
  const repo = new InMemoryRepo();
  const u = await repo.createUser({ name: 'Awa', role: 'contributor', competence: 1, phoneVerified: true, status: 'active' });
  await repo.updateUser(u.id, { language: 'Mooré', dialect: 'Yatenga', region: 'Nord', commercialConsent: true });
  const got = await repo.findUserById(u.id);
  assert.equal(got?.language, 'Mooré');
  assert.equal(got?.dialect, 'Yatenga');
  assert.equal(got?.region, 'Nord');
  assert.equal(got?.commercialConsent, true);
});

test('isProfileComplete : vrai seulement si les 3 champs sont présents', () => {
  assert.equal(isProfileComplete({ language: 'Mooré', dialect: 'Yatenga', region: 'Nord' }), true);
  assert.equal(isProfileComplete({ language: 'Mooré', dialect: 'Yatenga' }), false);
  assert.equal(isProfileComplete({}), false);
});

test('ProfileReq : rejette un corps invalide', () => {
  assert.throws(() => ProfileReq.parse({ language: 'Mooré' })); // dialect/region/commercialConsent manquants
});

test('ledgerHistoryFor : entrées du user, ordre antéchronologique', async () => {
  const repo = new InMemoryRepo();
  const u = await repo.createUser({ name: 'Ben', role: 'contributor', competence: 1, phoneVerified: true, status: 'active' });
  await repo.addLedger({ userId: u.id, delta: 50, reason: 'record', state: 'confirmed' });
  await repo.addLedger({ userId: u.id, delta: 20, reason: 'validate', state: 'confirmed' });
  const hist = await repo.ledgerHistoryFor(u.id);
  assert.equal(hist.length, 2);
  assert.equal(typeof hist[0].createdAt.getTime(), 'number');
  assert.ok(hist.every((e) => ['record', 'validate'].includes(e.reason)));
});

test('buildRegionCoverage : fusionne comptes clips et catalogue, pct plafonné', () => {
  const counts = [{ region: 'Ouagadougou', clips: 500 }, { region: 'Yatenga', clips: 2000 }];
  const cov = buildRegionCoverage(counts);
  const ouaga = cov.find((r) => r.region === 'Ouagadougou')!;
  const yat = cov.find((r) => r.region === 'Yatenga')!;
  const dori = cov.find((r) => r.region === 'Dori')!; // 0 clip → présent via catalogue
  assert.equal(ouaga.coveragePct, 0.5);
  assert.equal(yat.coveragePct, 1);    // 2000/1000 plafonné à 1
  assert.equal(dori.clips, 0);
  assert.equal(dori.zone, 'Sahel');
});
