import { type FastifyInstance } from 'fastify';
import { AdminLoginReq, AdminTotpReq } from '../auth/schemas';
import { signAccess, signAdminTotpChallenge, verifyAdminTotpChallenge } from '../auth/jwt';
import { verifyPassword } from '../auth/crypto';
import { verifyTotp } from '../auth/totp';
import { type Role } from '../domain/roles';
import { type Repo } from '../ports/repo';
import { CONFIG } from '../config';
import { checkRateLimit } from '../http/rateLimit';

const ELEVATED: ReadonlySet<Role> = new Set<Role>(['admin', 'moderator']);

// Surface ADMIN — /admin/auth/* (email+password PUIS TOTP ; challenge JWT lié).
export async function adminAuthRoutes(app: FastifyInstance, repo: Repo): Promise<void> {
  app.post('/login', async (req, reply) => {
    const ip = req.ip || 'unknown';
    const rl = checkRateLimit(`admin-login:${ip}`, { windowMs: 60_000, max: 10 });
    if (!rl.ok) {
      return reply.code(429).send({ error: { code: 'TOO_MANY_REQUESTS', message: `réessayer dans ${rl.retryAfterSec}s` } });
    }
    const body = AdminLoginReq.parse(req.body);
    const user = await repo.findUserByEmail(body.email);
    const ok = user && ELEVATED.has(user.role) && user.passwordHash && verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'accès refusé' } });
    }
    if ((user.status ?? 'active') !== 'active') {
      return reply.code(403).send({
        error: { code: 'ACCOUNT_DISABLED', message: 'Compte suspendu ou désactivé. Contactez SabiData.' },
      });
    }
    // Challenge signé (pas `totp:<uuid>` forgeable) — TTL 5 min.
    return reply.send({ challenge: signAdminTotpChallenge(user.id) });
  });

  app.post('/totp', async (req, reply) => {
    const ip = req.ip || 'unknown';
    const rl = checkRateLimit(`admin-totp:${ip}`, { windowMs: 60_000, max: 20 });
    if (!rl.ok) {
      return reply.code(429).send({ error: { code: 'TOO_MANY_REQUESTS', message: `réessayer dans ${rl.retryAfterSec}s` } });
    }
    const body = AdminTotpReq.parse(req.body);
    let userId: string;
    try {
      ({ sub: userId } = verifyAdminTotpChallenge(body.challenge));
    } catch {
      return reply.code(401).send({ error: { code: 'BAD_TOTP', message: '2FA invalide' } });
    }
    const user = await repo.findUserById(userId);
    if (!user || !ELEVATED.has(user.role) || !user.totpSecret || !verifyTotp(user.totpSecret, body.code)) {
      return reply.code(401).send({ error: { code: 'BAD_TOTP', message: '2FA invalide' } });
    }
    if ((user.status ?? 'active') !== 'active') {
      return reply.code(403).send({
        error: { code: 'ACCOUNT_DISABLED', message: 'Compte suspendu ou désactivé. Contactez SabiData.' },
      });
    }
    const access = signAccess(
      { sub: user.id, role: user.role, competence: user.competence, aud: 'admin' },
      CONFIG.jwt.adminSessionTtl,
    );
    await repo.addAudit({
      actorId: user.id, action: 'login', entityType: 'user', entityId: user.id,
      reason: '', metadata: { channel: 'admin' },
    });
    return reply.send({ access });
  });
}
