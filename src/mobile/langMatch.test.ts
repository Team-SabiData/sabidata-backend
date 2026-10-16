import { test } from 'node:test';
import assert from 'node:assert/strict';
import { langMatches } from './langMatch';

// L'app envoie les noms affichés (accents, majuscules) : « Mooré », « Fulfuldé ».
// Les prompts backend sont en ASCII : 'moore', 'fulfulde', 'dioula'.
test('langMatches — insensible aux accents et à la casse', () => {
  assert.ok(langMatches('moore', 'Mooré'));
  assert.ok(langMatches('fulfulde', 'Fulfuldé'));
  assert.ok(langMatches('dioula', 'Dioula'));
  assert.ok(langMatches('dioula', 'dioula'));
});

test('langMatches — pas de faux positifs entre langues', () => {
  assert.ok(!langMatches('moore', 'Dioula'));
  assert.ok(!langMatches('dioula', 'Fulfuldé'));
  assert.ok(!langMatches('fulfulde', 'Mooré'));
  assert.ok(!langMatches('moore', 'Gulmancema'));
});

test('langMatches — tolère les variantes partielles (préfixe/suffixe)', () => {
  assert.ok(langMatches('moore', 'mooré ')); // espace parasite
  assert.ok(langMatches('fulfulde', 'fulfulde'));
});
