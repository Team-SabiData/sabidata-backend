import { CONFIG } from '../config';
import { type Repo } from '../ports/repo';
import { type Withdrawal } from '../domain/contribution';
import { badRequest, conflict, forbidden } from '../errors';
import {
  countValidatedContributions,
  convertiblePoints,
  earnedPoints,
  levelFor,
  meetsWithdrawLevel,
  type Level,
} from '../domain/level';

// Portefeuille : agrégats dérivés du ledger (D4). Seuls les points gagnés
// APRÈS le niveau OR sont convertibles en FCFA ; les retraits en attente sont
// déjà débités du ledger (débit à la création).
export class WalletService {
  constructor(private readonly repo: Repo) {}

  async requestWithdrawal(userId: string, amountFcfa: number, provider: string): Promise<Withdrawal> {
    const ledger = await this.repo.ledgerFor(userId);
    const level = levelFor(earnedPoints(ledger));
    if (!meetsWithdrawLevel(level)) throw forbidden('LEVEL_TOO_LOW');
    if (!Number.isInteger(amountFcfa) || amountFcfa < CONFIG.withdrawMinFcfa) throw badRequest('BAD_AMOUNT');

    const points = convertiblePoints(ledger);
    const balanceFcfa = Math.floor(points * CONFIG.pointToFcfa);
    if (amountFcfa > balanceFcfa) throw conflict('INSUFFICIENT_FUNDS');

    await this.repo.addLedger({
      userId,
      delta: -Math.round(amountFcfa / CONFIG.pointToFcfa),
      reason: 'withdrawal',
      state: 'confirmed',
    });
    return this.repo.createWithdrawal({ userId, amountFcfa, provider });
  }

  async getWallet(userId: string): Promise<{
    pointsTotal: number;
    pointsPending: number;
    pointsEarned: number;
    pointsConvertible: number;
    balanceFcfa: number;
    contributionsValidated: number;
    level: Level;
    min: number;
    providers: string[];
  }> {
    const ledger = await this.repo.ledgerFor(userId);
    const pointsTotal = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
    const pointsPending = ledger.filter((e) => e.state === 'provisional').reduce((s, e) => s + e.delta, 0);
    const pointsEarned = earnedPoints(ledger);
    const pointsConvertible = convertiblePoints(ledger);
    const level = levelFor(pointsEarned);
    const contributionsValidated = countValidatedContributions(ledger);
    return {
      pointsTotal,
      pointsPending,
      pointsEarned,
      pointsConvertible,
      // Non rétroactif : les points antérieurs à OR ne sont pas convertis.
      balanceFcfa: meetsWithdrawLevel(level) ? Math.floor(pointsConvertible * CONFIG.pointToFcfa) : 0,
      contributionsValidated,
      level,
      min: CONFIG.withdrawMinFcfa,
      providers: ['orange_money', 'moov_money', 'wave'],
    };
  }
}
