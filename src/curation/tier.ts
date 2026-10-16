import { CONFIG } from '../config';

// Décision 1 / D1 — calcul du tier (système d'écriture × votes × cohérence,
// juge final « colle à l'audio »).
export type WritingSystem = 'std' | 'phon';
export type Tier = 'gold' | 'silver' | 'bronze' | 'raw';

export interface TierInput {
  writingSystem: WritingSystem;
  consistency: number;
  correct: number;
  problem: number;
  /** votes 'correct' émis par un validateur de competence >= competenceForGold */
  qualifiedCorrect: number;
}

export function computeTier(i: TierInput): { tier: Tier; matchesAudio: boolean | null } {
  let matchesAudio: boolean | null;
  if (i.problem >= 1 && i.correct < CONFIG.quorumAudio) matchesAudio = false;
  else if (i.correct >= CONFIG.quorumAudio) matchesAudio = true;
  else matchesAudio = null;

  let tier: Tier;
  if (matchesAudio !== true) {
    tier = 'raw';
  } else if (i.writingSystem === 'std') {
    if (i.qualifiedCorrect >= CONFIG.reviewsForGold) tier = 'gold';
    else if (i.correct >= CONFIG.quorumAudio) tier = 'silver';
    else tier = 'raw';
  } else {
    if (i.consistency >= CONFIG.consistencyHigh && i.correct >= CONFIG.quorumAudio) tier = 'silver';
    else if (i.consistency >= CONFIG.consistencyOk) tier = 'bronze';
    else tier = 'raw';
  }
  return { tier, matchesAudio };
}
