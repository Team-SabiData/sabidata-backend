import * as OTPAuth from 'otpauth';

// TOTP (RFC 6238) — second facteur admin. Le secret par admin est stocké en base
// (users.totp_secret) ; jamais de code « accepté parce qu'il fait 6 chiffres ».
const ISSUER = 'SabiData';

function totp(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: ISSUER, secret: OTPAuth.Secret.fromBase32(secret) });
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

// window:1 tolère ±1 pas (30 s) pour le décalage d'horloge.
export function verifyTotp(secret: string, token: string): boolean {
  return totp(secret).validate({ token, window: 1 }) !== null;
}

// Code courant — usage dev/test uniquement (jamais exposé par une route).
export function currentTotp(secret: string): string {
  return totp(secret).generate();
}
