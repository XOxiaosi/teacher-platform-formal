import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRealDshLocalEnvironment, parseRealDshLocalArgs, validateRealDshLocalOptions } from './real-dsh-local-config.mjs';

function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'real-dsh-local-config-'));
  const root = join(base, 'source'); const runtimeRoot = join(base, 'runtime'); const apiKeyFile = join(base, 'key.env');
  mkdirSync(root); mkdirSync(runtimeRoot); writeFileSync(apiKeyFile, 'DEEPSEEK_API_KEY=synthetic-only');
  try { run({ root, base, input: { directory: join(base, 'new-data'), runtimeRoot, apiKeyFile, serverPort: 3002, databasePort: 55433 } }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('requires explicit fresh isolated paths and two different nonreserved ports', () => fixture(({ root, input }) => {
  assert.equal(validateRealDshLocalOptions(input, root).serverPort, 3002);
  for (const value of [0, 80, 5432, 55432, 3001, 65536, '3002;whoami', '3e3']) {
    assert.throws(() => validateRealDshLocalOptions({ ...input, serverPort: value }, root));
    assert.throws(() => validateRealDshLocalOptions({ ...input, databasePort: value }, root));
  }
  assert.throws(() => validateRealDshLocalOptions({ ...input, databasePort: 3002 }, root));
  for (const directory of ['relative', '/', root, join(root, 'data'), join(input.runtimeRoot, 'data')]) {
    assert.throws(() => validateRealDshLocalOptions({ ...input, directory }, root));
  }
  mkdirSync(input.directory);
  assert.throws(() => validateRealDshLocalOptions(input, root), /已有目录/);
}));

test('resolves symlink ancestors and rejects credentials within either source tree', () => fixture(({ root, base, input }) => {
  const link = join(base, 'source-link'); symlinkSync(root, link);
  assert.throws(() => validateRealDshLocalOptions({ ...input, directory: join(link, 'hidden-data') }, root));
  for (const owner of [root, input.runtimeRoot]) {
    const key = join(owner, 'key.env'); writeFileSync(key, 'synthetic');
    assert.throws(() => validateRealDshLocalOptions({ ...input, apiKeyFile: key }, root));
  }
  assert.throws(() => validateRealDshLocalOptions({ ...input, apiKeyFile: base }, root), /类型/);
}));

test('sanitizes ambient services, credentials, database and host while enabling only explicit DSH', () => fixture(({ root, input }) => {
  const config = validateRealDshLocalOptions(input, root);
  const env = buildRealDshLocalEnvironment(config, { encryptionKey: 'a'.repeat(64), actionSecret: 'b'.repeat(64) }, {
    PATH: '/synthetic/bin', DATABASE_URL: 'postgres://real-database', DEEPSEEK_API_KEY: 'ambient-secret',
    ARK_API_KEY: 'ambient-secret', NODE_OPTIONS: '--import=untrusted', HOME: '/real-home',
    LOCAL_SAFE_MODE: 'false', PLATFORM_SERVICES_ENABLED: 'true', WECHAT_ILINK_ENABLED: 'true',
    DEEPSEEK_MODEL: 'unexpected-model', PORT: '80', LISTEN_HOST: '0.0.0.0',
  });
  assert.equal(env.DATABASE_URL, 'postgresql://postgres@127.0.0.1:55433/teacher_platform');
  assert.equal(env.LISTEN_HOST, '127.0.0.1'); assert.equal(env.PORT, '3002');
  assert.equal(env.LOCAL_SAFE_MODE, 'true'); assert.equal(env.PLATFORM_SERVICES_ENABLED, 'false');
  assert.equal(env.WECHAT_ILINK_ENABLED, 'false'); assert.equal(env.DSH_RUNTIME_ENABLED, 'true');
  assert.equal(env.DSH_SESSION_ROOT, join(config.directory, 'dsh-sessions'));
  assert.equal(env.DSH_RUNTIME_ROOT, config.runtimeRoot); assert.equal(env.DEEPSEEK_API_KEY_FILE, config.apiKeyFile);
  for (const key of ['ARK_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'NODE_OPTIONS', 'HOME']) assert.equal(env[key], undefined);
  assert.throws(() => buildRealDshLocalEnvironment(config, { encryptionKey: '', actionSecret: '' }));
}));

test('CLI rejects duplicate, unknown and incomplete options', () => {
  assert.deepEqual(parseRealDshLocalArgs(['/tmp/new-data', '--port', '3002', '--db-port', '55433']), { directory: '/tmp/new-data', serverPort: '3002', databasePort: '55433' });
  for (const flags of [['--port'], ['--database-url', 'real-db'], ['--port', '3002', '--port', '3003']]) {
    assert.throws(() => parseRealDshLocalArgs(['/tmp/new-data', ...flags]));
  }
});
