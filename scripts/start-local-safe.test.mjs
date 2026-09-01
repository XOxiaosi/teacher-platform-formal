import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalSafeEnvironment } from './start-local-safe.mjs';

test('safe launcher passes only system variables and forced local-safe settings', () => {
  const safe = buildLocalSafeEnvironment({
    ARK_API_KEY: 'must-not-pass',
    DATABASE_URL: 'postgresql://real-host/production',
    NODE_OPTIONS: '--require ./unsafe-hook.cjs',
    PATH: '/usr/bin',
    PORT: '4310',
    S3_ACCESS_KEY: 'must-not-pass',
    WECHAT_ILINK_ENABLED: 'true',
  }, 'test-only-action-token');

  assert.equal(safe.PATH, '/usr/bin');
  assert.equal(safe.PORT, '4310');
  assert.equal(safe.ACTION_TOKEN_SECRET, 'test-only-action-token');
  assert.equal(safe.DATABASE_URL, 'postgresql://postgres@127.0.0.1:1/teacher_platform_local_safe_unavailable');
  assert.equal(safe.LOCAL_SAFE_MODE, 'true');
  assert.equal(safe.PLATFORM_SERVICES_ENABLED, 'false');
  assert.equal(safe.STORAGE_BACKEND, 'local');
  assert.equal(safe.WECHAT_ILINK_ENABLED, 'false');
  assert.equal('ARK_API_KEY' in safe, false);
  assert.equal('NODE_OPTIONS' in safe, false);
  assert.equal('S3_ACCESS_KEY' in safe, false);
});
