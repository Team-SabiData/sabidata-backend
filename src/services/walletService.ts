import { CONFIG } from '../config';
import { type Repo } from '../ports/repo';
import { type Withdrawal } from '../domain/contribution';
import { badRequest, conflict, forbidden } from '../errors';
import { countValidatedContributions, levelFor, meetsWithdrawLevel, type Level } from '../domain/level';

// Portefeuille : agrégats dérivés du ledger (D4). Le solde retirable ne compte
// que les points CONFIRMÉS (× taux FCFA).
export class WalletService {
  constructor(private readonly repo: Repo) {}

  // POINT D'ENTRÉE OBLIGATOIRE pour toute demande de retrait (admin ou future
  // route mobile) : débite le ledger à la CRÉATION du retrait, pas à la
  // décision. Sans ce débit initial, approuver un retrait ne coûte rien au
  // solde et refuser re-crédite un montant qui n'a jamais été retiré — cf.
  // AdminService.decideWithdrawal qui re-crédite (withdrawal_refund) sur
  // refus, en miroir de ce débit.
  async requestWithdrawal(userId: string, amountFcfa: number, provider: string): Promise<Withdrawal> {
    const ledger = await this.repo.ledgerFor(userId);
    if (!meetsWithdrawLevel(levelFor(countValidatedContributions(ledger)))) throw forbidden('LEVEL_TOO_LOW');
    if (!Number.isInteger(amountFcfa) || amountFcfa < CONFIG.withdrawMinFcfa) throw badRequest('BAD_AMOUNT');
    const pointsTotal = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
    const balanceFcfa = pointsTotal * CONFIG.pointToFcfa;
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
    balanceFcfa: number;
    contributionsValidated: number;
    level: Level;
    min: number;
    providers: string[];
  }> {
    const ledger = await this.repo.ledgerFor(userId);
    const pointsTotal = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
    const pointsPending = ledger.filter((e) => e.state === 'provisional').reduce((s, e) => s + e.delta, 0);
    const contributionsValidated = countValidatedContributions(ledger);
    return {
      pointsTotal,
      pointsPending,
      balanceFcfa: pointsTotal * CONFIG.pointToFcfa,
      contributionsValidated,
      level: levelFor(contributionsValidated),
      min: CONFIG.withdrawMinFcfa,
      providers: ['orange_money', 'moov_money', 'wave'],
    };
  }
}
