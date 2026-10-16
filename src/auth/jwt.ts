import jwt from 'jsonwebtoken';
import { type Role, type CompetenceLevel } from '../domain/roles';

// Secret de repli DEV uniquement — interdit en prod par assertProdSecurity
// (config/prodGuard.ts), qui fait échouer le démarrage si JWT_SECRET vaut ceci.
export const DEV_JWT_SECRET = 'dev-secret-change-me';
const SECRET: string = process.env.JWT_SECRET ?? DEV_JWT_SECRET;

// Décision 3 — audience distincte mobile vs admin (séparation des surfaces).
export interface Claims {
  sub: string;
  role: Role;
  competence: CompetenceLevel;
  aud: 'mobile' | 'admin';
}

export function signAccess(claims: Claims, ttl: string): string {
  return jwt.sign(claims, SECRET, { expiresIn: ttl } as jwt.SignOptions);
}

export function verifyAccess(token: string, audience: 'mobile' | 'admin'): Claims {
  return jwt.verify(token, SECRET, { audience }) as unknown as Claims;
}

// Refresh token mobile : longue durée, ne porte que l'identité (le rôle et la
// compétence à jour sont relus depuis la base au moment du /refresh).
export function signRefresh(sub: string, ttl: string): string {
  return jwt.sign({ sub, typ: 'refresh', aud: 'mobile' }, SECRET, { expiresIn: ttl } as jwt.SignOptions);
}

export function verifyRefresh(token: string): { sub: string } {
  const p = jwt.verify(token, SECRET, { audience: 'mobile' }) as { sub: string; typ?: string };
  if (p.typ !== 'refresh') throw new Error('NOT_REFRESH');
  return { sub: p.sub };
}

/** Challenge admin post-password : lié à l'identité, TTL court, non forgeable sans JWT_SECRET. */
export function signAdminTotpChallenge(userId: string, ttl = '5m'): string {
  return jwt.sign({ sub: userId, typ: 'admin_totp', aud: 'admin' }, SECRET, {
    expiresIn: ttl,
  } as jwt.SignOptions);
}

export function verifyAdminTotpChallenge(token: string): { sub: string } {
  const p = jwt.verify(token, SECRET, { audience: 'admin' }) as { sub: string; typ?: string };
  if (p.typ !== 'admin_totp') throw new Error('NOT_ADMIN_CHALLENGE');
  return { sub: p.sub };
}
