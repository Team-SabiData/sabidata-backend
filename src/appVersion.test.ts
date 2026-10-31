import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server';
import { InMemoryRepo } from './ports/repo';
import { compareAppVersions, parseAppVersion } from './http/appVersion';

test('comparaison des versions applicatives', () => {
  assert.deepEqual(parseAppVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseAppVersion('v2.0'), [2, 0, 0]);
  assert.deepEqual(parseAppVersion('1.0.0+42'), [1, 0, 0]);
  assert.equal(parseAppVersion('nope'), null);
  assert.equal(compareAppVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareAppVersions('1.2.0', '1.3.0'), -1);
  assert.equal(compareAppVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareAppVersions('bad', '1.0.0'), null);
});

test('garde de compatibilité mobile et endpoint public /api/config', async () => {
  const previous = process.env.MIN_APP_VERSION;
  process.env.MIN_APP_VERSION = '1.2.0';
  try {
    const app = buildServer(new InMemoryRepo());

    const config = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(config.statusCode, 200);
    const cfg = config.json() as { apiVersion: string; rbacVersion: number; minAppVersion: string | null };
    assert.equal(cfg.apiVersion, 'v1');
    assert.equal(cfg.rbacVersion, 2);
    assert.equal(cfg.minAppVersion, '1.2.0');

    const missing = await app.inject({ method: 'GET', url: '/api/regions' });
    assert.equal(missing.statusCode, 426);
    assert.match(missing.body, /UPGRADE_REQUIRED/);

    const old = await app.inject({
      method: 'GET', url: '/api/regions', headers: { 'x-app-version': '1.1.9' },
    });
    assert.equal(old.statusCode, 426);

    const ok = await app.inject({
      method: 'GET', url: '/api/regions', headers: { 'x-app-version': '1.2.0' },
    });
    assert.equal(ok.statusCode, 200);
  } finally {
    if (previous === undefined) delete process.env.MIN_APP_VERSION;
    else process.env.MIN_APP_VERSION = previous;
  }
});
