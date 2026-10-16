#!/usr/bin/env tsx
/**
 * Crée le premier admin de production (mot de passe + secret TOTP).
 *
 * Usage :
 *   ADMIN_EMAIL=ops@sabidata.bf ADMIN_PASSWORD='…' ADMIN_NAME='Ops' \
 *     npm run bootstrap-admin
 *
 * Affiche le secret TOTP (base32) à enregistrer dans une app 2FA.
 * Ne crée rien si l'email existe déjà.
 */
import { hashPassword } from '../src/auth/crypto';
import { generateTotpSecret, currentTotp } from '../src/auth/totp';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || 'Admin SabiData';

  if (!email || !password || password.length < 8) {
    console.error('ADMIN_EMAIL et ADMIN_PASSWORD (≥ 8 car.) requis');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL requis');
    process.exit(1);
  }

  const { createPgDb } = await import('../src/db/pg');
  const { ensureSchema } = await import('../src/db/sql');
  const { PgRepo } = await import('../src/ports/pgRepo');

  const db = createPgDb(process.env.DATABASE_URL);
  await ensureSchema(db);
  const repo = new PgRepo(db);

  const existing = await repo.findUserByEmail(email);
  if (existing) {
    console.error(`Utilisateur déjà présent : ${email} (id=${existing.id}, role=${existing.role})`);
    process.exit(2);
  }

  const totpSecret = generateTotpSecret();
  const user = await repo.createUser({
    name,
    role: 'admin',
    competence: 3,
    email,
    passwordHash: hashPassword(password),
    phoneVerified: true,
    totpSecret,
  });

  console.log('Admin créé.');
  console.log(`  id:    ${user.id}`);
  console.log(`  email: ${email}`);
  console.log(`  TOTP secret (base32) : ${totpSecret}`);
  console.log(`  TOTP code courant    : ${currentTotp(totpSecret)}`);
  console.log('Enregistre le secret dans ton app 2FA (issuer SabiData), puis change le mot de passe après première connexion.');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
