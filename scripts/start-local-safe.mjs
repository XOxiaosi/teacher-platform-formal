import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SYSTEM_ENV_ALLOWLIST = [
  'HOME', 'LANG', 'LC_ALL', 'PATH', 'PATHEXT', 'SystemRoot',
  'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'USER', 'USERPROFILE',
];

function localPort(value) {
  const port = Number(value ?? 3000);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? String(port) : '3000';
}

/**
 * Deliberately use an allowlist: a shell's DATABASE_URL, provider key, webhook,
 * storage credentials, or an old workspace's .env must never reach safe mode.
 * Port 1 is intentionally unavailable, so readiness reports degraded instead of
 * connecting to a developer's local PostgreSQL instance.
 */
export function buildLocalSafeEnvironment(
  source = process.env,
  actionTokenSecret = randomBytes(32).toString('hex'),
) {
  const system = Object.fromEntries(
    SYSTEM_ENV_ALLOWLIST.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
  return {
    ...system,
    ACTION_TOKEN_SECRET: actionTokenSecret,
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:1/teacher_platform_local_safe_unavailable',
    LISTEN_HOST: '127.0.0.1',
    LOCAL_SAFE_MODE: 'true',
    PLATFORM_SERVICES_ENABLED: 'false',
    PORT: localPort(source.PORT),
    STORAGE_BACKEND: 'local',
    WECHAT_ILINK_ENABLED: 'false',
  };
}

export function startLocalSafe() {
  const child = spawn(process.execPath, ['packages/backend/dist/index.js'], {
    cwd: root,
    stdio: 'inherit',
    env: buildLocalSafeEnvironment(),
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalSafe();
}
