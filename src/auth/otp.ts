import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** OTP à 6 chiffres (espace de recherche ×100 vs 4 chiffres). */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function otpMatches(plain: string, storedHash: string): boolean {
  try {
    const a = Buffer.from(hashOtp(plain), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
