import { type Role, type Permission, type CompetenceLevel, roleHas } from '../domain/roles';

/** Identité authentifiée portée par chaque requête. */
export interface Principal {
  userId: string;
  role: Role;
  competence: CompetenceLevel;
  audience: 'mobile' | 'admin';
}

/** Garde central d'accès (décision 1 : un seul endroit). */
export function can(p: Principal, perm: Permission): boolean {
  return roleHas(p.role, perm);
}

/** Routage de contenu par compétence (décision 1/2) : un validateur ne traite
 *  que le contenu à son niveau ou en dessous. */
export function canHandleContent(p: Principal, requiredCompetence: number): boolean {
  return can(p, 'validate') && p.competence >= requiredCompetence;
}

export class ForbiddenError extends Error {
  constructor(public readonly perm: Permission) {
    super(`forbidden: ${perm}`);
  }
}

export function requirePermission(p: Principal, perm: Permission): void {
  if (!can(p, perm)) throw new ForbiddenError(perm);
}
