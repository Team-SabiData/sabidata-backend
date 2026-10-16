import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTier } from './curation/tier';
import { consensusNext, autocheck, canTransition } from './curation/stateMachine';
import { can, canHandleContent, type Principal } from './authz/can';

// ── D1 : tiers ───────────────────────────────────────────────────────────────
test('D1 — standard + 2 relecteurs qualifiés + colle audio = OR', () => {
  const r = computeTier({ writingSystem: 'std', consistency: 1, correct: 2, problem: 0, qualifiedCorrect: 2 });
  assert.equal(r.tier, 'gold');
  assert.equal(r.matchesAudio, true);
});

test('D1 — beau standard qui NE colle PAS à l\'audio tombe en raw', () => {
  const r = computeTier({ writingSystem: 'std', consistency: 1, correct: 0, problem: 2, qualifiedCorrect: 0 });
  assert.equal(r.matchesAudio, false);
  assert.equal(r.tier, 'raw'); // le juge final prime sur le système
});

test('D1 — phonétique cohérent validé = silver (récupérable, > standard douteux)', () => {
  const r = computeTier({ writingSystem: 'phon', consistency: 0.9, correct: 2, problem: 0, qualifiedCorrect: 0 });
  assert.equal(r.tier, 'silver');
});

test('D1 — phonétique cohérent non encore haut = bronze (→ tâche de conversion)', () => {
  const r = computeTier({ writingSystem: 'phon', consistency: 0.7, correct: 2, problem: 0, qualifiedCorrect: 0 });
  assert.equal(r.tier, 'bronze');
});

// ── D2/D3 : machine à états + consensus ──────────────────────────────────────
test('D2 — transitions légales', () => {
  assert.ok(canTransition('pending', 'auto_checked'));
  assert.ok(canTransition('peer_review', 'disputed'));
  assert.ok(!canTransition('validated', 'pending')); // terminal
});

test('D2 — auto-check rejette une durée hors bornes', () => {
  assert.equal(autocheck(5).passed, true);
  assert.equal(autocheck(0).passed, false);
  assert.equal(autocheck(60).passed, false);
});

test('D3 — consensus net : 2 correct → validated, 2 problem → rejected, litige → disputed', () => {
  assert.equal(consensusNext('peer_review', { correct: 2, problem: 0, total: 2 }), 'validated');
  assert.equal(consensusNext('peer_review', { correct: 0, problem: 2, total: 2 }), 'rejected');
  assert.equal(consensusNext('peer_review', { correct: 3, problem: 2, total: 5 }), 'disputed');
  assert.equal(consensusNext('peer_review', { correct: 1, problem: 0, total: 1 }), 'peer_review');
});

// ── D1 RBAC : garde central ──────────────────────────────────────────────────
function p(role: Principal['role'], competence: Principal['competence'] = 0): Principal {
  return { userId: 'u', role, competence, audience: role === 'admin' || role === 'moderator' ? 'admin' : 'mobile' };
}

test('RBAC — contributeur ne peut pas modérer, admin peut tout', () => {
  assert.equal(can(p('contributor'), 'content.moderate'), false);
  assert.equal(can(p('validator'), 'validate'), true);
  assert.equal(can(p('moderator'), 'content.moderate'), true);
  assert.equal(can(p('admin'), 'export.run'), true); // '*'
});

test('Compétence — routage de contenu orthogonal au rôle', () => {
  assert.equal(canHandleContent(p('validator', 1), 1), true);
  assert.equal(canHandleContent(p('validator', 1), 3), false); // niveau insuffisant
  // Validation ouverte : un contributeur valide un clip normal (compétence 0)…
  assert.equal(canHandleContent(p('contributor', 0), 0), true);
  // …mais le routage par compétence lui interdit les clips rares.
  assert.equal(canHandleContent(p('contributor', 0), 2), false);
});
