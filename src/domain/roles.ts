// Décision 1 — RBAC : enum rôle (accès grossier) + competence_level ordinal.

export const RBAC_VERSION = 2;

export const ROLES = ['contributor', 'validator', 'moderator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'contribute'
  | 'transcribe'
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
  | 'export.run'
  | 'support.manage';

// SOURCE UNIQUE rôle -> droits (miroir de la table role_permissions).
// '*' = tout (admin). competence_level n'est PAS ici : c'est de la donnée de
// routage de contenu, pas un droit d'accès.
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission | '*'>> = {
  // Séparation stricte : le contributeur enregistre et transcrit, le validateur
  // valide uniquement. Seul un admin peut promouvoir un compte en validateur.
  contributor: new Set(['contribute', 'transcribe']),
  validator: new Set(['validate']),
  moderator: new Set([
    'validate',
    'content.read_any',
    'content.moderate',
    'dispute.arbitrate',
    'support.manage',
  ]),
  admin: new Set(['*']),
};

export function roleHas(role: Role, perm: Permission): boolean {
  const set = ROLE_PERMISSIONS[role];
  return set.has('*') || set.has(perm);
}

const ALL_PERMISSIONS: Permission[] = [
  'contribute', 'transcribe', 'validate', 'content.read_any', 'content.moderate', 'dispute.arbitrate',
  'reference.manage', 'user.manage', 'wallet.read', 'wallet.adjust', 'withdrawal.settle',
  'audit.read', 'export.run', 'support.manage',
];

/** Liste des permissions effectives d'un rôle (pour /admin/me). */
export function permissionsFor(role: Role): Permission[] {
  const set = ROLE_PERMISSIONS[role];
  if (set.has('*')) return [...ALL_PERMISSIONS];
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

// Niveau de compétence ordinal (orthogonal au rôle).
export type CompetenceLevel = 0 | 1 | 2 | 3;
