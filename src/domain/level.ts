import { CONFIG } from '../config';
import { type LedgerEntry } from './contribution';

export type Level = 'none' | 'bronze' | 'argent' | 'or';

// Raisons qui comptent comme un gain de points (les retraits/remboursements
// ne sont pas des gains, mais les anciens barèmes validate/transcribe restent
// comptabilisés pour les soldes historiques).
const EARNING = new Set(['record', 'validate', 'transcribe', 'convert', 'admin_adjustment']);

/** Points cumulés gagnés (entrées confirmées, gains uniquement). */
export function earnedPoints(ledger: LedgerEntry[]): number {
  return ledger
    .filter((e) => e.state === 'confirmed' && EARNING.has(e.reason) && e.delta > 0)
    .reduce((s, e) => s + e.delta, 0);
}

/** Nombre de contributions validées (compatibilité ancien portefeuille). */
export function countValidatedContributions(ledger: LedgerEntry[]): number {
  const CONTRIBUTIVE = new Set(['record', 'validate', 'transcribe', 'convert']);
  return ledger.filter((e) => e.state === 'confirmed' && CONTRIBUTIVE.has(e.reason)).length;
}

/** Palier dérivé des points cumulés gagnés. */
export function levelFor(pointsEarned: number): Level {
  if (pointsEarned >= CONFIG.levels.orAt) return 'or';
  if (pointsEarned >= CONFIG.levels.argentAt) return 'argent';
  if (pointsEarned >= CONFIG.levels.bronzeAt) return 'bronze';
  return 'none';
}

/** Vrai si le niveau atteint le seuil de conversion FCFA (OR). */
export function meetsWithdrawLevel(level: Level): boolean {
  return level === 'or';
}

/**
 * Points convertibles : seuls ceux gagnés APRÈS avoir atteint OR.
 * Les retraits déjà effectués sont déduits ; un retrait refusé est re-crédité.
 */
export function convertiblePoints(ledger: LedgerEntry[]): number {
  let earned = 0;
  let postOrEarned = 0;
  let withdrawn = 0;
  let refunded = 0;

  for (const e of ledger) {
    if (e.state !== 'confirmed') continue;
    if (e.reason === 'withdrawal') {
      withdrawn += -e.delta;
      continue;
    }
    if (e.reason === 'withdrawal_refund') {
      refunded += e.delta;
      continue;
    }
    if (EARNING.has(e.reason) && e.delta > 0) {
      // La fraction d'un gain qui dépasse le seuil OR est déjà « après OR »
      // (ex. un seul gain de 5000 pts en convertit 500).
      const after = earned + e.delta;
      if (after > CONFIG.levels.orAt) {
        postOrEarned += Math.min(e.delta, after - CONFIG.levels.orAt);
      }
      earned = after;
    }
  }
  return Math.max(0, postOrEarned + refunded - withdrawn);
}
