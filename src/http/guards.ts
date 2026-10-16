import { type FastifyReply, type FastifyRequest } from 'fastify';
import { verifyAccess } from '../auth/jwt';
import { can, type Principal } from '../authz/can';
import { type Permission, type Role, type CompetenceLevel } from '../domain/roles';
import { type Repo } from '../ports/repo';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

// Recharge rôle / compétence / statut depuis la DB (anti stale JWT après demote/suspend).
export function authenticate(audience: 'mobile' | 'admin', repo: Repo) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) {
      await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
      return;
    }
    try {
      const c = verifyAccess(h.slice(7), audience);
      const user = await repo.findUserById(c.sub);
      if (!user || (user.status ?? 'active') !== 'active') {
        await reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'compte invalide ou désactivé' } });
        return;
      }
      // Audience admin : rôle encore élevé ?
      if (audience === 'admin' && user.role !== 'admin' && user.role !== 'moderator') {
        await reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'rôle insuffisant' } });
        return;
      }
      req.principal = {
        userId: user.id,
        role: user.role as Role,
        competence: user.competence as CompetenceLevel,
        audience,
      };
    } catch {
      await reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'token invalide' } });
    }
  };
}

export function requirePerm(perm: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.principal || !can(req.principal, perm)) {
      await reply.code(403).send({ error: { code: 'FORBIDDEN', message: perm } });
    }
  };
}
