import { type Principal, requirePermission } from '../authz/can';
import { canTransition } from '../curation/stateMachine';
import { type Repo } from '../ports/repo';
import { type AuditEntry } from '../domain/contribution';
import { conflict, notFound } from '../errors';

type ArbitrationResult = 'validated' | 'rejected';

// Surface ADMIN — gouvernance des litiges. L'admin-web ne touche que les clips
// `disputed` (delta-v2 §2) ; chaque arbitrage est consigné au journal immuable.
export class GovernanceService {
  constructor(private readonly repo: Repo) {}

  // POST /admin/clips/:id/arbitrate — résout un litige et ajuste le ledger D4.
  async arbitrate(
    p: Principal,
    clipId: string,
    result: ArbitrationResult,
    reason: string,
  ): Promise<{ status: ArbitrationResult; reason: string }> {
    requirePermission(p, 'dispute.arbitrate');
    const clip = await this.repo.getClip(clipId);
    if (!clip) throw notFound('clip');
    if (clip.status !== 'disputed') throw conflict('not_disputed');
    if (!canTransition('disputed', result)) throw conflict('bad_result');

    await this.repo.setClipStatus(clipId, result);
    // D4 : le crédit provisoire de l'enregistrement est confirmé ou reversé.
    await this.repo.setRecordLedgerState(clipId, result === 'validated' ? 'confirmed' : 'reversed');

    await this.repo.addAudit({
      actorId: p.userId,
      action: 'clip.arbitrate',
      entityType: 'clip',
      entityId: clipId,
      reason,
      metadata: { result },
    });
    return { status: result, reason };
  }

  // GET /admin/audit-log — lecture seule du journal (jamais de mutation exposée).
  async listAudit(filter?: { actorId?: string; entityId?: string; action?: string }): Promise<AuditEntry[]> {
    return this.repo.listAudit(filter);
  }
}
