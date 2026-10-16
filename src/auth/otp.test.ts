import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOtpCode, hashOtp, otpMatches } from './otp';

test('generateOtpCode — 6 chiffres', () => {
  for (let i = 0; i < 20; i++) {
    const c = generateOtpCode();
    assert.match(c, /^\d{6}$/);
  }
});

test('hashOtp / otpMatches — round-trip timing-safe', () => {
  const code = '123456';
  const h = hashOtp(code);
  assert.notEqual(h, code);
  assert.equal(otpMatches(code, h), true);
  assert.equal(otpMatches('000000', h), false);
});
