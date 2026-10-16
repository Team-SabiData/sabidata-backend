import { argon2id } from '@noble/hashes/argon2.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Hachage de mots de passe — argon2id (paramètres OWASP, sel aléatoire 16 o).
// Format auto-descriptif : `argon2id$m=..,t=..,p=..$<saltHex>$<hashHex>`.
const PARAMS = { m: 19456, t: 2, p: 1 } as const; // m en KiB (~19 Mio)

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

function derive(plain: string, salt: Uint8Array): Uint8Array {
  return argon2id(new TextEncoder().encode(plain), salt, { m: PARAMS.m, t: PARAMS.t, p: PARAMS.p });
}

export function hashPassword(plain: string): string {
  const salt = new Uint8Array(randomBytes(16));
  const hash = derive(plain, salt);
  return `argon2id$m=${PARAMS.m},t=${PARAMS.t},p=${PARAMS.p}$${hex(salt)}$${hex(hash)}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'argon2id') return false;
  const m = /m=(\d+),t=(\d+),p=(\d+)/.exec(parts[1] ?? '');
  if (!m) return false;
  try {
    const salt = unhex(parts[2]!);
    const expected = unhex(parts[3]!);
    const got = argon2id(new TextEncoder().encode(plain), salt, {
      m: Number(m[1]), t: Number(m[2]), p: Number(m[3]),
    });
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}
