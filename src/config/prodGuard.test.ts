import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProdSecurity, isProduction, isStaging } from './prodGuard';

const okProd = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a-real-long-random-secret',
  SMS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://u:p@host/db',
  S3_BUCKET: 'sabi-audio',
};

test('isProduction — vrai seulement si NODE_ENV=production', () => {
  assert.equal(isProduction({ NODE_ENV: 'production' }), true);
  assert.equal(isProduction({ NODE_ENV: 'development' }), false);
  assert.equal(isProduction({}), false);
});

test('isStaging — STAGING=true ou 1', () => {
  assert.equal(isStaging({ STAGING: 'true' }), true);
  assert.equal(isStaging({ STAGING: '1' }), true);
  assert.equal(isStaging({ STAGING: 'false' }), false);
  assert.equal(isStaging({}), false);
});

test('assertProdSecurity — ne lève pas hors production même si tout manque', () => {
  assert.doesNotThrow(() => assertProdSecurity({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertProdSecurity({})); // NODE_ENV absent = pas prod
});

test('assertProdSecurity — config prod complète : ne lève pas', () => {
  assert.doesNotThrow(() => assertProdSecurity(okProd));
});

test('assertProdSecurity — staging sans SMS : ne lève pas si JWT+DB+S3 OK', () => {
  assert.doesNotThrow(() =>
    assertProdSecurity({
      ...okProd,
      SMS_ENABLED: 'false',
      STAGING: 'true',
    }),
  );
});

test('assertProdSecurity — prod sans JWT_SECRET : lève', () => {
  assert.throws(
    () => assertProdSecurity({ ...okProd, JWT_SECRET: undefined }),
    /JWT_SECRET/,
  );
});

test('assertProdSecurity — prod avec JWT_SECRET placeholder : lève', () => {
  assert.throws(
    () => assertProdSecurity({ ...okProd, JWT_SECRET: 'dev-secret-change-me' }),
    /JWT_SECRET/,
  );
});

test('assertProdSecurity — prod sans DATABASE_URL : lève', () => {
  assert.throws(
    () => assertProdSecurity({ ...okProd, DATABASE_URL: undefined }),
    /DATABASE_URL/,
  );
});

test('assertProdSecurity — prod sans S3_BUCKET : lève', () => {
  assert.throws(
    () => assertProdSecurity({ ...okProd, S3_BUCKET: undefined }),
    /S3_BUCKET/,
  );
});

test('assertProdSecurity — prod sans SMS_ENABLED=true et hors staging : lève', () => {
  assert.throws(() => assertProdSecurity({ ...okProd, SMS_ENABLED: 'false' }), /SMS_ENABLED/);
  assert.throws(() => assertProdSecurity({ ...okProd, SMS_ENABLED: undefined }), /SMS_ENABLED/);
});

test('assertProdSecurity — agrège tous les problèmes dans le message', () => {
  try {
    assertProdSecurity({ NODE_ENV: 'production' });
    assert.fail('aurait dû lever');
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /JWT_SECRET/);
    assert.match(msg, /DATABASE_URL/);
    assert.match(msg, /S3_BUCKET/);
    assert.match(msg, /SMS_ENABLED/);
  }
});
