import { CONFIG } from '../config';

// Décision 2 — machine à états possédée par le backend (jamais par un client).
export const CLIP_STATES = [
  'pending',
  'auto_checked',
  'peer_review',
  'validated',
  'rejected',
  'disputed',
] as const;
export type ClipState = (typeof CLIP_STATES)[number];

const TRANSITIONS: Record<ClipState, ReadonlyArray<ClipState>> = {
  pending: ['auto_checked', 'rejected'],
  auto_checked: ['peer_review', 'rejected'],
  peer_review: ['validated', 'rejected', 'disputed'],
  validated: [],
  rejected: [],
  disputed: ['validated', 'rejected'], // arbitrage admin
};

export function canTransition(from: ClipState, to: ClipState): boolean {
  return TRANSITIONS[from].includes(to);
}

// Auto-check (format/durée/silence). Le calcul média réel est un job (D6) ;
// ici la règle de durée + la transition d'état.
export function autocheck(durationS: number): { passed: boolean; report: Record<string, unknown> } {
  const { minSeconds, maxSeconds } = CONFIG.autocheck;
  const passed = durationS >= minSeconds && durationS <= maxSeconds;
  return { passed, report: { durationS, minSeconds, maxSeconds } };
}

export interface VoteTally {
  correct: number;
  problem: number;
  total: number;
}

// Consensus net (D3) appliqué pendant la pair-review.
export function consensusNext(state: ClipState, t: VoteTally): ClipState {
  if (state !== 'peer_review') return state;
  const net = t.correct - t.problem;
  if (net >= CONFIG.netValidate) return 'validated';
  if (net <= -CONFIG.netReject) return 'rejected';
  if (t.total >= CONFIG.votesCap) return 'disputed';
  return 'peer_review';
}
