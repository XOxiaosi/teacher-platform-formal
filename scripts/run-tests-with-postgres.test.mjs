import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_DATABASE,
  HARNESS_SENTINEL_PREFIX,
  PROJECT_ROOT,
  TEMP_PREFIX,
  assertChildHarnessEnvironment,
  assertPostgres17,
  assertSafeTemporaryDirectory,
  buildHarnessEnvironment,
  childCommand,
  makeDatabaseUrl,
  removeTemporaryDirectory,
  runLifecycle,
  runTestsWithPostgres,
  startManagedChild,
} from './run-tests-with-postgres.mjs';

test('white-list environment removes ambient database, provider, webhook, storage, and platform secrets', () => {
  const temporaryDirectory = join(tmpdir(), `${TEMP_PREFIX}environment`);
  const environment = buildHarnessEnvironment({
    source: {
      PATH: '/safe/bin',
      DATABASE_URL: 'postgresql://real-host/production',
      NODE_OPTIONS: '--require=/private/ambient-hook.cjs',
      ARK_API_KEY: 'real-provider-key',
      WECHAT_WEBHOOK: 'https://example.invalid',
      S3_SECRET_ACCESS_KEY: 'real-storage-key',
      PLATFORM_TOKEN: 'platform-token',
      HOME: '/Users/teacher',
      NPM_CONFIG_USERCONFIG: '/Users/teacher/.npmrc',
    },
    databaseUrl: makeDatabaseUrl('55439'),
    tempDirectory: temporaryDirectory,
  });
  assert.equal(environment.PATH, '/safe/bin');
  assert.equal(environment.LANG, 'C');
  assert.equal(environment.LC_ALL, 'C');
  assert.equal(environment.DATABASE_URL, `postgresql://postgres@127.0.0.1:55439/${BASE_DATABASE}`);
  assert.equal(environment.ARK_API_KEY, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.WECHAT_WEBHOOK, undefined);
  assert.equal(environment.S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.PLATFORM_TOKEN, undefined);
  assert.notEqual(environment.HOME, '/Users/teacher');
  assert.notEqual(environment.NPM_CONFIG_USERCONFIG, '/Users/teacher/.npmrc');
  assert.equal(environment.NPM_CONFIG_USERCONFIG, join(temporaryDirectory, '.npmrc'));
  assert.match(environment.TEACHER_PLATFORM_ISOLATED_TEST_HARNESS, new RegExp(`^${HARNESS_SENTINEL_PREFIX}[a-f0-9]{64}$`));
  assert.equal(environment.PLATFORM_SERVICES_ENABLED, 'false');
  assert.equal(environment.WECHAT_ILINK_ENABLED, 'false');
  assert.match(environment.ACTION_TOKEN_SECRET, /^[a-f0-9]{64}$/);
  assert.match(environment.ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
});

test('child sentinel blocks direct test:with-database before legacy database configuration is read', () => {
  assert.throws(() => assertChildHarnessEnvironment({
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:55439/teacher_platform',
    TEACHER_PLATFORM_TEST_DATABASE: '1',
  }), /SAFETY_BLOCK/);
  const environment = buildHarnessEnvironment({
    databaseUrl: makeDatabaseUrl('55439'),
    tempDirectory: join(tmpdir(), `${TEMP_PREFIX}sentinel`),
  });
  assert.doesNotThrow(() => assertChildHarnessEnvironment(environment));
  assert.throws(() => assertChildHarnessEnvironment({
    ...environment,
    DATABASE_URL: 'postgresql://postgres@127.0.0.1/teacher_platform',
  }), /SAFETY_BLOCK/);
});

test('refuses unsafe ports and unsafe cleanup targets', () => {
  assert.throws(() => makeDatabaseUrl('5432'), /SAFETY_BLOCK/);
  assert.throws(() => makeDatabaseUrl('55432'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTemporaryDirectory(join(tmpdir(), 'not-a-test-directory')), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTemporaryDirectory(PROJECT_ROOT), /SAFETY_BLOCK/);
  assert.throws(() => removeTemporaryDirectory(join(tmpdir(), 'not-a-test-directory')), /SAFETY_BLOCK/);
});

test('child command is exactly the full test sequence, not a shell or external database command', () => {
  const command = childCommand();
  assert.match(command.command, /^npm(?:\.cmd)?$/);
  assert.deepEqual(command.args, ['run', 'test:with-database']);
});

test('lifecycle always cleans up after child failure and preserves the failing exit status', async () => {
  const calls = [];
  const status = await runLifecycle({
    setup: () => calls.push('setup'),
    runChild: () => { calls.push('child'); return 17; },
    cleanup: ({ setupCompleted }) => calls.push(`cleanup:${setupCompleted}`),
  });
  assert.equal(status, 17);
  assert.deepEqual(calls, ['setup', 'child', 'cleanup:true']);
});

test('lifecycle cleans up after setup error and does not run the child', async () => {
  const calls = [];
  await assert.rejects(() => runLifecycle({
    setup: () => { calls.push('setup'); throw new Error('initdb failed'); },
    runChild: () => { calls.push('child'); return 0; },
    cleanup: ({ setupCompleted }) => calls.push(`cleanup:${setupCompleted}`),
  }), /initdb failed/);
  assert.deepEqual(calls, ['setup', 'cleanup:false']);
});

test('lifecycle does not hide a cleanup error after an otherwise successful child', async () => {
  await assert.rejects(() => runLifecycle({
    setup: () => {},
    runChild: () => 0,
    cleanup: () => { throw new Error('pg_ctl stop failed'); },
  }), /pg_ctl stop failed/);
});

test('failed PostgreSQL start removes a cluster that never began listening', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const execute = (command, args) => {
    if (args[0] === '--version') return { status: 0, stdout: `${command} (PostgreSQL) 17.10\n`, stderr: '' };
    if (command === 'pg_ctl' && args[0] === 'start') return { status: 1 };
    return { status: 0 };
  };
  await assert.rejects(() => runTestsWithPostgres({
    execute,
    makeTempDirectory: () => temporaryDirectory,
  }), /SETUP_FAILED: pg_ctl start/);
  assert.equal(existsSync(temporaryDirectory), false);
});

test('managed child receives SIGTERM and exits without remaining alive', async () => {
  const managed = startManagedChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(managed.child, 'spawn');
  assert.equal(managed.terminate('SIGTERM'), true);
  const result = await managed.completion;
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(managed.child.exitCode, null);
  assert.equal(managed.child.signalCode, 'SIGTERM');
});

test('preflight recognises only PostgreSQL 17 tool output', () => {
  const postgres17 = () => ({ status: 0, stdout: 'initdb (PostgreSQL) 17.10\n', stderr: '' });
  assert.doesNotThrow(() => assertPostgres17('initdb', postgres17));
  const postgres16 = () => ({ status: 0, stdout: 'initdb (PostgreSQL) 16.9\n', stderr: '' });
  assert.throws(() => assertPostgres17('initdb', postgres16), /SAFETY_BLOCK/);
});
