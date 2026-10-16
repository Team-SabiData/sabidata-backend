import { type Principal, requirePermission } from '../authz/can';
import { type Repo, type UserStatus } from '../ports/repo';
import { type Role, type CompetenceLevel } from '../domain/roles';
import { hashPassword } from '../auth/crypto';
import { CONFIG } from '../config';
import { badRequest, conflict, notFound } from '../errors';

// Surface ADMIN — gestion des comptes et de l'argent. Chaque écriture exige
// un motif et laisse une trace immuable dans l'audit_log. Le ledger est
// append-only : on n'édite jamais une ligne, on en ajoute.
export class AdminService {
  constructor(private readonly repo: Repo) {}

  private needReason(reason: string): string {
    const r = reason?.trim();
    if (!r) throw badRequest('REASON_REQUIRED');
    return r;
  }

  // checkLastAdmin=false quand l'action ne retire pas un admin actif (ex.
  // réactiver un admin suspendu) : le garde SELF_FORBIDDEN s'applique
  // toujours, mais compter les admins actifs n'a de sens que si on en retire un.
  private async guardTarget(p: Principal, targetId: string, checkLastAdmin = true): Promise<void> {
    if (p.userId === targetId) throw conflict('SELF_FORBIDDEN');
    const target = await this.repo.findUserById(targetId);
    if (!target) throw notFound('user');
    if (checkLastAdmin && target.role === 'admin') {
      const admins = (await this.repo.listUsers()).filter(
        (u) => u.role === 'admin' && (u.status ?? 'active') === 'active',
      );
      if (admins.length <= 1) throw conflict('LAST_ADMIN');
    }
  }

  async setUserStatus(p: Principal, id: string, status: Exclude<UserStatus, 'deleted'>, reason: string) {
    requirePermission(p, 'user.manage');
    const r = this.needReason(reason);
    // Réactiver (status === 'active') ne retire aucun admin actif : le check
    // LAST_ADMIN ne s'applique qu'aux transitions qui en retirent un.
    await this.guardTarget(p, id, status !== 'active');
    const updated = await this.repo.updateUser(id, { status });
    if (!updated) throw notFound('user');
    await this.repo.addAudit({
      actorId: p.userId, action: 'user.status', entityType: 'user', entityId: id,
      reason: r, metadata: { status },
    });
    return { id, status };
  }

  // Changement de rôle/compétence — passe par les MÊMES garde-fous que le
  // statut (SELF_FORBIDDEN, LAST_ADMIN) dès qu'il rétrograde un admin, et
  // exige un motif journalisé. Un self-change qui ne rétrograde pas un admin
  // (ex. un admin qui ajuste sa propre compétence) reste permis.
  async changeRole(
    p: Principal,
    id: string,
    patch: { role?: Role; competence?: CompetenceLevel },
    reason: string,
  ) {
    requirePermission(p, 'user.manage');
    const r = this.needReason(reason);
    const target = await this.repo.findUserById(id);
    if (!target) throw notFound('user');
    // Rétrograder un admin (ou soi-même) obéit aux mêmes garde-fous que le statut.
    const demotesAdmin = target.role === 'admin' && patch.role !== undefined && patch.role !== 'admin';
    if (p.userId === id && demotesAdmin) throw conflict('SELF_FORBIDDEN');
    if (demotesAdmin) await this.guardTarget(p, id);
    const updated = await this.repo.updateUser(id, { role: patch.role, competence: patch.competence });
    if (!updated) throw notFound('user');
    await this.repo.addAudit({
      actorId: p.userId, action: 'user.update', entityType: 'user', entityId: id,
      reason: r, metadata: { role: patch.role, competence: patch.competence },
    });
    return { id: updated.id, role: updated.role, competence: updated.competence };
  }

  async createUser(p: Principal, input: { name: string; email?: string; phone?: string; role: Role; password?: string }) {
    requirePermission(p, 'user.manage');
    if (!input.name?.trim() || (!input.email && !input.phone)) throw badRequest('BAD_INPUT');
    const user = await this.repo.createUser({
      name: input.name.trim(),
      role: input.role,
      competence: 0,
      email: input.email,
      phone: input.phone,
      passwordHash: input.password ? hashPassword(input.password) : undefined,
      phoneVerified: false,
      status: 'active',
    });
    await this.repo.addAudit({
      actorId: p.userId, action: 'user.create', entityType: 'user', entityId: user.id,
      reason: '', metadata: { role: input.role },
    });
    return { id: user.id, name: user.name, role: user.role };
  }

  async deleteUser(p: Principal, id: string, reason: string) {
    requirePermission(p, 'user.manage');
    const r = this.needReason(reason);
    await this.guardTarget(p, id);
    const updated = await this.repo.updateUser(id, {
      status: 'deleted',
      name: 'Utilisateur supprimé',
      email: null,
      phone: null,
      passwordHash: null,
      totpSecret: null,
    });
    if (!updated) throw notFound('user');
    await this.repo.addAudit({
      actorId: p.userId, action: 'user.delete', entityType: 'user', entityId: id, reason: r,
    });
    return { id, status: 'deleted' as const };
  }

  async adjustBalance(p: Principal, id: string, delta: number, reason: string) {
    requirePermission(p, 'wallet.adjust');
    const r = this.needReason(reason);
    if (!Number.isInteger(delta) || delta === 0) throw badRequest('BAD_DELTA');
    const target = await this.repo.findUserById(id);
    if (!target) throw notFound('user');
    if ((target.status ?? 'active') === 'deleted') throw conflict('USER_DELETED');
    await this.repo.addLedger({ userId: id, delta, reason: 'admin_adjustment', state: 'confirmed' });
    await this.repo.addAudit({
      actorId: p.userId, action: 'wallet.adjust', entityType: 'user', entityId: id,
      reason: r, metadata: { delta },
    });
    const ledger = await this.repo.ledgerFor(id);
    const pointsTotal = ledger.filter((e) => e.state === 'confirmed').reduce((s, e) => s + e.delta, 0);
    return { pointsTotal };
  }

  async decideWithdrawal(p: Principal, id: string, decision: 'approved' | 'rejected', reason: string) {
    requirePermission(p, 'withdrawal.settle');
    const r = this.needReason(reason);
    const w = await this.repo.getWithdrawal(id);
    if (!w) throw notFound('withdrawal');
    if (w.status !== 'processing') throw conflict('ALREADY_DECIDED');
    const status = decision === 'approved' ? ('paid' as const) : ('failed' as const);
    await this.repo.setWithdrawalStatus(id, status);
    if (status === 'failed') {
      // Refus → re-crédit append-only (FCFA reconvertis en points).
      await this.repo.addLedger({
        userId: w.userId,
        delta: Math.round(w.amountFcfa / CONFIG.pointToFcfa),
        reason: 'withdrawal_refund',
        state: 'confirmed',
      });
    }
    await this.repo.addAudit({
      actorId: p.userId, action: 'withdrawal.decide', entityType: 'withdrawal', entityId: id,
      reason: r, metadata: { decision, amountFcfa: w.amountFcfa, userId: w.userId },
    });
    return { status };
  }
}
