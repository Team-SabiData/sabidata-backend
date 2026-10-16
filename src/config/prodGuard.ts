import { DEV_JWT_SECRET } from '../auth/jwt';

// Sous-ensemble d'env lu par le garde (facilite les tests).
type Env = Record<string, string | undefined>;

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function isStaging(env: Env = process.env): boolean {
  return env.STAGING === 'true' || env.STAGING === '1';
}

// Fail-fast au démarrage : en production, les valeurs par défaut « dev »
// (secret JWT public, seed admin par défaut, OTP « 0000 ») sont des portes
// dérobées. On refuse de démarrer plutôt que de servir silencieusement dessus.
// Le seed admin de dev, lui, est sauté selon isProduction() côté boot.
//
// STAGING=true : premier go-live Railway sans SMS réel — JWT + DB + S3
// restent obligatoires ; SMS_ENABLED=false est toléré uniquement dans ce cas.
export function assertProdSecurity(env: Env = process.env): void {
  if (!isProduction(env)) return;
  const problems: string[] = [];

  if (!env.JWT_SECRET || env.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET manquant ou égal au placeholder de dev (signature forgeable)');
  }
  if (!env.DATABASE_URL) {
    problems.push('DATABASE_URL manquant (Postgres managé requis en production)');
  }
  // S3/R2 obligatoire en prod publique ; en STAGING on tolère le filesystem (volume).
  if (!env.S3_BUCKET && !isStaging(env)) {
    problems.push('S3_BUCKET manquant (stockage objet R2/S3 requis en production)');
  }
  // Sans ceci, generateOtp() renvoie « 0000 » → toute prise de compte par OTP.
  // En staging explicite, on tolère SMS off pour le premier déploiement.
  if (env.SMS_ENABLED !== 'true' && !isStaging(env)) {
    problems.push(
      'SMS_ENABLED doit valoir "true" en production (sinon OTP factice « 0000 ») — ou STAGING=true pour un go-live contrôlé',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Configuration de production non sécurisée — démarrage refusé :\n  - ${problems.join('\n  - ')}`,
    );
  }
}
