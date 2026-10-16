// Décision 1 — RBAC : enum rôle (accès grossier) + competence_level ordinal.

export const ROLES = ['contributor', 'validator', 'moderator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'contribute'
  | 'validate'
  | 'content.read_any'
  | 'content.moderate'
  | 'dispute.arbitrate'
  | 'reference.manage'
  | 'user.manage'
  | 'wallet.read'
  | 'wallet.adjust'
  | 'withdrawal.settle'
  | 'audit.read'
  | 'export.run';

// SOURCE UNIQUE rôle -> droits (miroir de la table role_permissions).
// '*' = tout (admin). competence_level n'est PAS ici : c'est de la donnée de
// routage de contenu, pas un droit d'accès.
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission | '*'>> = {
  // Validation ouverte à tous les contributeurs (peer-review) ; le routage par
  // compétence réserve les clips rares aux validateurs plus qualifiés.
  contributor: new Set(['contribute', 'validate']),
  validator: new Set(['contribute', 'validate']),
  moderator: new Set([
    'validate',
    'content.read_any',
    'content.moderate',
    'dispute.arbitrate',
  ]),
  admin: new Set(['*']),
};

export function roleHas(role: Role, perm: Permission): boolean {
  const set = ROLE_PERMISSIONS[role];
  return set.has('*') || set.has(perm);
}

// Niveau de compétence ordinal (orthogonal au rôle).
export type CompetenceLevel = 0 | 1 | 2 | 3;
