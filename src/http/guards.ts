import { type FastifyReply, type FastifyRequest } from 'fastify';
import { verifyAccess } from '../auth/jwt';
import { can, type Principal } from '../authz/can';
import { type Permission } from '../domain/roles';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

// Décision 3 — séparation des surfaces : on exige l'audience attendue.
export function authenticate(audience: 'mobile' | 'admin') {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) {
      await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
      return;
    }
    try {
      const c = verifyAccess(h.slice(7), audience);
      req.principal = { userId: c.sub, role: c.role, competence: c.competence, audience: c.aud };
    } catch {
      await reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'token invalide' } });
    }
  };
}

// Garde de permission, branché sur le garde central can().
export function requirePerm(perm: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.principal || !can(req.principal, perm)) {
      await reply.code(403).send({ error: { code: 'FORBIDDEN', message: perm } });
    }
  };
}
