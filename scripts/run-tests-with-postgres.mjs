#!/usr/bin/env node
/**
 * Full regression database harness.
 *
 * The product test entry point must never borrow a developer's PostgreSQL,
 * .env, or provider credentials.  Every run owns a short-lived PostgreSQL 17
 * cluster under the operating-system temp directory, and removes it after
 * either a passing, failing, or interrupted child test run.
 */
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(scriptDir, '..');
export const TEMP_PREFIX = 'teacher-platform-pg17-';
export const BASE_DATABASE = 'teacher_platform';
export const RESERVED_PORTS = new Set(['5432', '55432']);
export const HARNESS_SENTINEL_PREFIX = 'teacher-platform-pg17:';
export const SYSTEM_ENV_ALLOWLIST = [
  'LANG', 'LC_ALL', 'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TZ',
];

const prismaBin = resolve(PROJECT_ROOT, 'node_modules/prisma/build/index.js');
const schemaPath = resolve(PROJECT_ROOT, 'packages/contracts/prisma/schema.prisma');

function systemEnvironment(source = process.env) {
  return Object.fromEntries(
    SYSTEM_ENV_ALLOWLIST.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

export function buildHarnessEnvironment({ source = process.env, databaseUrl, tempDirectory } = {}) {
  if (!(databaseUrl instanceof URL)) throw new Error('SAFETY_BLOCK: 缺少合成 DATABASE_URL');
  assertSafeTemporaryDirectory(tempDirectory);
  return {
    ...systemEnvironment(source),
    // npm must not consult the developer's HOME/.npmrc (which can contain a
    // registry token).  Its home and user config are owned by this run.
    HOME: join(tempDirectory, 'home'),
    USERPROFILE: join(tempDirectory, 'home'),
    NPM_CONFIG_USERCONFIG: join(tempDirectory, '.npmrc'),
    TMPDIR: join(tempDirectory, 'tmp'),
    TEMP: join(tempDirectory, 'tmp'),
    TMP: join(tempDirectory, 'tmp'),
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.toString(),
    TEACHER_PLATFORM_TEST_DATABASE: '1',
    TEACHER_PLATFORM_ISOLATED_TEST_HARNESS: `${HARNESS_SENTINEL_PREFIX}${randomBytes(32).toString('hex')}`,
    ACTION_TOKEN_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    PLATFORM_SERVICES_ENABLED: 'false',
    WECHAT_ILINK_ENABLED: 'false',
    STORAGE_BACKEND: 'local',
    MEDIA_STORAGE_ROOT: join(tempDirectory, 'media'),
    BACKUP_ROOT: join(tempDirectory, 'backups'),
    TEST_MUTEX_LOCK_PATH: join(tempDirectory, '.test-mutex'),
  };
}

/** Guard the direct child script before any package can read DATABASE_URL/.env. */
export function assertChildHarnessEnvironment(environment = process.env) {
  const sentinel = environment.TEACHER_PLATFORM_ISOLATED_TEST_HARNESS;
  if (typeof sentinel !== 'string' || !new RegExp(`^${HARNESS_SENTINEL_PREFIX}[a-f0-9]{64}$`).test(sentinel)) {
    throw new Error('SAFETY_BLOCK: test:with-database 只能由 PostgreSQL 17 隔离 harness 启动');
  }
  if (environment.TEACHER_PLATFORM_TEST_DATABASE !== '1') {
    throw new Error('SAFETY_BLOCK: 缺少隔离测试数据库标记');
  }
  let url;
  try {
    url = new URL(environment.DATABASE_URL);
  } catch {
    throw new Error('SAFETY_BLOCK: 缺少隔离 DATABASE_URL');
  }
  const effectivePort = url.port || '5432';
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.pathname !== `/${BASE_DATABASE}` || RESERVED_PORTS.has(effectivePort)) {
    throw new Error('SAFETY_BLOCK: test:with-database 拒绝非 harness 的数据库');
  }
  return true;
}

export function assertSafeTemporaryDirectory(directory, tempRoot = tmpdir()) {
  if (!directory || typeof directory !== 'string') {
    throw new Error('SAFETY_BLOCK: 临时目录缺失');
  }
  const resolvedDirectory = resolve(directory);
  const resolvedTempRoot = resolve(tempRoot);
  const relationship = relative(resolvedTempRoot, resolvedDirectory);
  if (relationship === '' || relationship === '..' || relationship.startsWith(`..${pathSeparator()}`) || isAbsolute(relationship)) {
    throw new Error('SAFETY_BLOCK: 临时目录必须位于系统临时目录内');
  }
  if (!basename(resolvedDirectory).startsWith(TEMP_PREFIX)) {
    throw new Error('SAFETY_BLOCK: 拒绝删除没有测试前缀的目录');
  }
  if (resolvedDirectory === PROJECT_ROOT || resolvedDirectory.startsWith(`${PROJECT_ROOT}${pathSeparator()}`)) {
    throw new Error('SAFETY_BLOCK: 临时目录不得位于源码树');
  }
  return resolvedDirectory;
}

function basename(path) {
  return path.split(/[\\/]/).at(-1) ?? '';
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

export function makeDatabaseUrl(port) {
  if (!/^\d+$/.test(String(port)) || RESERVED_PORTS.has(String(port))) {
    throw new Error('SAFETY_BLOCK: PostgreSQL 端口不安全');
  }
  return new URL(`postgresql://postgres@127.0.0.1:${port}/${BASE_DATABASE}`);
}

export function childCommand() {
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'test:with-database'],
  };
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
  });
}

function runRequired(command, args, options, label, execute = commandResult) {
  const result = execute(command, args, options);
  if (result.error) throw new Error(`SAFETY_BLOCK: ${label} 无法启动：${result.error.message}`);
  if (result.status !== 0) throw new Error(`SETUP_FAILED: ${label} 返回 ${result.status ?? '未知'}`);
  return result;
}

export function assertPostgres17(executable, execute = commandResult) {
  const result = execute(executable, ['--version'], { stdio: 'pipe' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error || result.status !== 0 || !/PostgreSQL\)\s+17(?:\.|\s|$)/.test(output)) {
    throw new Error(`SAFETY_BLOCK: ${executable} 必须是可用的 PostgreSQL 17 工具`);
  }
}

export function preflight(execute = commandResult) {
  for (const executable of ['initdb', 'pg_ctl', 'createdb']) assertPostgres17(executable, execute);
  if (!existsSync(prismaBin)) throw new Error('SAFETY_BLOCK: Prisma CLI 不存在；请先运行 npm ci');
  return true;
}

function allocatePort() {
  // PostgreSQL needs a fixed port at startup.  The OS selects an ephemeral one
  // here; the short bind-to-start gap is still guarded by PostgreSQL refusing a
  // collision, rather than silently falling back to any existing service.
  const probe = spawnSync(process.execPath, ['-e', [
    "const net=require('node:net');",
    "const server=net.createServer();",
    "server.listen(0, '127.0.0.1', () => {",
    "process.stdout.write(String(server.address().port)); server.close();",
    '});',
  ].join(' ')], { encoding: 'utf8' });
  const port = probe.stdout?.trim();
  if (probe.status !== 0 || !port || RESERVED_PORTS.has(port)) {
    throw new Error('SAFETY_BLOCK: 无法取得安全的临时 PostgreSQL 端口');
  }
  return port;
}

function pgEnvironment(environment, port, database = 'postgres') {
  return {
    ...environment,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'postgres',
    PGDATABASE: database,
  };
}

export function removeTemporaryDirectory(directory, remove = rmSync) {
  const safeDirectory = assertSafeTemporaryDirectory(directory);
  remove(safeDirectory, { recursive: true, force: true, maxRetries: 3 });
}

/** The lifecycle is exported so failure/cleanup behavior is unit-testable. */
export async function runLifecycle({ setup, runChild, cleanup }) {
  let setupCompleted = false;
  let childStatus = 1;
  let primaryError;
  try {
    await setup();
    setupCompleted = true;
    childStatus = await runChild();
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanup({ setupCompleted });
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
      else process.stderr.write(`CLEANUP_FAILED: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    }
  }
  if (primaryError) throw primaryError;
  return childStatus;
}

/**
 * Start npm in its own group so Ctrl-C/TERM reaches npm and all test descendants.
 * POSIX group termination is covered by the signal regression. On Windows we
 * use child.kill only; process-tree forwarding there remains an explicit
 * validation gap until it is exercised on a Windows runner.
 */
export function startManagedChild(command, args, { cwd = PROJECT_ROOT, env, spawnProcess = spawn } = {}) {
  const child = spawnProcess(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const completion = new Promise((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.once('close', (code, signal) => resolveResult({ code: code ?? 1, signal }));
  });
  const terminate = (signal) => {
    if (child.exitCode !== null || child.signalCode) return false;
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal);
        return true;
      }
      return child.kill(signal);
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  return { child, completion, terminate };
}

export function isPortListening(port) {
  return new Promise((resolveListening) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveListening(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function runTestsWithPostgres({
  execute = commandResult,
  makeTempDirectory = () => mkdtempSync(join(tmpdir(), TEMP_PREFIX)),
  remove = rmSync,
  setupCheck = false,
  childCommandFactory = childCommand,
  onChildStarted,
  onCleanup,
} = {}) {
  preflight(execute);
  const tempDirectory = makeTempDirectory();
  assertSafeTemporaryDirectory(tempDirectory);
  const dataDirectory = join(tempDirectory, 'data');
  mkdirSync(join(tempDirectory, 'home'), { recursive: true });
  mkdirSync(join(tempDirectory, 'tmp'), { recursive: true });
  writeFileSync(join(tempDirectory, '.npmrc'), '', { flag: 'wx' });
  mkdirSync(join(tempDirectory, 'media'), { recursive: true });
  mkdirSync(join(tempDirectory, 'backups'), { recursive: true });
  const port = allocatePort();
  const databaseUrl = makeDatabaseUrl(port);
  const environment = buildHarnessEnvironment({ databaseUrl, tempDirectory });
  let clusterStarted = false;
  let activeChild = null;
  let signal = null;
  const recordSignal = (name) => {
    signal ??= name;
    activeChild?.terminate(name);
  };
  const onSigint = () => recordSignal('SIGINT');
  const onSigterm = () => recordSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const status = await runLifecycle({
      setup: () => {
        runRequired('initdb', ['--no-locale', '--encoding=UTF8', '--auth=trust', '--username=postgres', '--pgdata', dataDirectory], { env: environment }, 'initdb', execute);
        // Mark before executing start so cleanup also handles a partially-started
        // server if pg_ctl reports an error after launching postgres.
        clusterStarted = true;
        runRequired('pg_ctl', ['start', '--wait', '--timeout', '30', '--pgdata', dataDirectory, '--options', `-h 127.0.0.1 -p ${port}`, '--silent'], { env: environment }, 'pg_ctl start', execute);
        runRequired('createdb', [BASE_DATABASE], { env: pgEnvironment(environment, port) }, 'createdb teacher_platform', execute);
        runRequired(process.execPath, [prismaBin, 'migrate', 'deploy', '--schema', schemaPath], { env: environment }, 'prisma migrate deploy', execute);
      },
      runChild: async () => {
        if (setupCheck) return 0;
        if (signal) return 1;
        const { command, args } = childCommandFactory();
        activeChild = startManagedChild(command, args, { cwd: PROJECT_ROOT, env: environment });
        onChildStarted?.(activeChild.child);
        const result = await activeChild.completion;
        activeChild = null;
        return result.code;
      },
      cleanup: () => {
        if (clusterStarted) {
          const result = execute('pg_ctl', ['stop', '--wait', '--timeout', '30', '--pgdata', dataDirectory, '--mode', 'fast', '--silent'], { env: environment });
          // Never remove a data directory while PostgreSQL may still be using
          // it. Keep this strict-prefix directory for diagnosis instead.
          if (result.error || result.status !== 0) {
            throw new Error('CLEANUP_FAILED: PostgreSQL 临时集群停止失败；已保留临时目录');
          }
        }
        removeTemporaryDirectory(tempDirectory, remove);
        onCleanup?.({ tempDirectory, port });
      },
    });
    if (signal) return signal === 'SIGINT' ? 130 : 143;
    return status;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function runSignalCheck() {
  let cleanup;
  const status = await runTestsWithPostgres({
    childCommandFactory: () => ({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    }),
    onChildStarted: () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100),
    onCleanup: (details) => { cleanup = details; },
  });
  if (status !== 143 || !cleanup || existsSync(cleanup.tempDirectory)
    || await isPortListening(cleanup.port)) {
    throw new Error('SIGNAL_CHECK_FAILED: 测试子进程、临时目录或端口未完成清理');
  }
  process.stdout.write('PostgreSQL 17 isolated test harness: SIGNAL_CHECK_PASS\n');
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--preflight')) {
    preflight();
    process.stdout.write('PostgreSQL 17 isolated test harness: PREFLIGHT_PASS\n');
    return;
  }
  if (arguments_.includes('--assert-child-sentinel')) {
    assertChildHarnessEnvironment();
    process.stdout.write('PostgreSQL 17 isolated test harness: CHILD_SENTINEL_PASS\n');
    return;
  }
  if (arguments_.includes('--signal-check')) {
    await runSignalCheck();
    return;
  }
  const setupCheck = arguments_.includes('--setup-check');
  process.exitCode = await runTestsWithPostgres({ setupCheck });
  if (process.exitCode === 0 && setupCheck) {
    process.stdout.write('PostgreSQL 17 isolated test harness: SETUP_CHECK_PASS\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
