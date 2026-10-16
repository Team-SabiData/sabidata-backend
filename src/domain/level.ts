import { CONFIG } from '../config';
import { type LedgerEntry } from './contribution';

export type Level = 'bronze' | 'argent' | 'or';

const CONTRIBUTIVE = new Set(['record', 'validate', 'transcribe', 'convert']);

/** Nombre de contributions validées = entrées ledger confirmées et contributives. */
export function countValidatedContributions(ledger: LedgerEntry[]): number {
  return ledger.filter((e) => e.state === 'confirmed' && CONTRIBUTIVE.has(e.reason)).length;
}

/** Palier dérivé du nombre de contributions validées. */
export function levelFor(validatedCount: number): Level {
  if (validatedCount >= CONFIG.levels.orAt) return 'or';
  if (validatedCount >= CONFIG.levels.argentAt) return 'argent';
  return 'bronze';
}

/** Vrai si le niveau atteint le seuil de retrait (≥ Argent). */
export function meetsWithdrawLevel(level: Level): boolean {
  return level !== 'bronze';
}
