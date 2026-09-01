import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSmokeEnvironment } from './smoke-built-backend.mjs';

test('built backend smoke rejects ambient opt-out and all service credentials', () => {
  const safe = buildSmokeEnvironment({
    LOCAL_SAFE_MODE: 'false',
    DATABASE_URL: 'postgresql://real-host/production',
    ARK_API_KEY: 'real-ai-key',
    PROVIDER_KEY_ENCRYPTION_KEY: 'real-provider-key',
    S3_SECRET_ACCESS_KEY: 'real-storage-secret',
    WECHAT_ILINK_APPSECRET: 'real-wechat-secret',
    OUTBOUND_WEBHOOK_URL: 'https://example.invalid/webhook',
    NODE_OPTIONS: '--require ./unsafe-hook.cjs',
    PATH: '/usr/bin',
  }, 45123);

  assert.equal(safe.LOCAL_SAFE_MODE, 'true');
  assert.equal(safe.PORT, '45123');
  assert.equal(safe.DATABASE_URL, 'postgresql://postgres@127.0.0.1:1/teacher_platform_runtime_smoke');
  assert.equal(safe.PATH, '/usr/bin');
  for (const key of [
    'ARK_API_KEY',
    'PROVIDER_KEY_ENCRYPTION_KEY',
    'S3_SECRET_ACCESS_KEY',
    'WECHAT_ILINK_APPSECRET',
    'OUTBOUND_WEBHOOK_URL',
    'NODE_OPTIONS',
  ]) {
    assert.equal(key in safe, false, `${key} must not reach built backend smoke`);
  }
});
