import { type FastifyInstance } from 'fastify';
import { AdminLoginReq, AdminTotpReq } from '../auth/schemas';
import { signAccess } from '../auth/jwt';
import { verifyPassword } from '../auth/crypto';
import { verifyTotp } from '../auth/totp';
import { type Role } from '../domain/roles';
import { type Repo } from '../ports/repo';
import { CONFIG } from '../config';

const ELEVATED: ReadonlySet<Role> = new Set<Role>(['admin', 'moderator']);

// Surface ADMIN — /admin/auth/* (décision 3 : email+password PUIS TOTP
// obligatoire ; jamais de token sans 2FA ; session courte).
export async function adminAuthRoutes(app: FastifyInstance, repo: Repo): Promise<void> {
  app.post('/login', async (req, reply) => {
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
    // Étape 1 OK → exiger le second facteur, AUCUN token émis ici.
    return reply.send({ challenge: `totp:${user.id}` });
  });

  app.post('/totp', async (req, reply) => {
    const body = AdminTotpReq.parse(req.body);
    const userId = body.challenge.replace(/^totp:/, '');
    const user = userId ? await repo.findUserById(userId) : null;
    // Re-vérifie le privilège ET le second facteur contre le secret stocké.
    if (!user || !ELEVATED.has(user.role) || !user.totpSecret || !verifyTotp(user.totpSecret, body.code)) {
      return reply.code(401).send({ error: { code: 'BAD_TOTP', message: '2FA invalide' } });
    }
    // Re-vérifie le statut : un compte suspendu ENTRE /login et /totp ne doit
    // obtenir ni token ni événement audit login (fenêtre de suspension).
    if ((user.status ?? 'active') !== 'active') {
      return reply.code(403).send({
        error: { code: 'ACCOUNT_DISABLED', message: 'Compte suspendu ou désactivé. Contactez SabiData.' },
      });
    }
    // Session courte, audience 'admin' — on signe le RÔLE RÉEL (pas 'admin' en dur).
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
