#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_READY_URL,
  FRONTEND_URL,
  buildRestoreInvocation,
  classifyManagedProcesses,
  createSafeChildEnvironment,
  parseAndValidateState,
  redactSensitiveText,
  runStartSequence,
  validateControllerRequest,
} from './windows-controller-core.mjs';
import { withPostgresBinPath } from '../packages/ops/lib/pg-utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '..');
const runtimeRoot = resolve(repoRoot, '.data/windows-m0');
const backupRoot = resolve(runtimeRoot, 'backups');
const statePath = resolve(runtimeRoot, 'controller-state.json');
const baselinePath = resolve(repoRoot, 'deploy/runtime-baseline.json');
const envPath = resolve(repoRoot, '.env');
const packageLockPath = resolve(repoRoot, 'package-lock.json');
const initScriptPath = resolve(repoRoot, 'packages/ops/scripts/db-init-local.mjs');
const backupScriptPath = resolve(repoRoot, 'packages/ops/scripts/db-backup.mjs');
const restoreScriptPath = resolve(repoRoot, 'packages/ops/scripts/db-restore.mjs');
const vitePath = resolve(repoRoot, 'node_modules/vite/bin/vite.js');
const tsxImport = 'tsx';
const markers = {
  backend: resolve(repoRoot, 'packages/backend/src/index.ts'),
  frontend: vitePath,
};
const logPaths = {
  backend: {
    stdout: resolve(runtimeRoot, 'backend.stdout.log'),
    stderr: resolve(runtimeRoot, 'backend.stderr.log'),
  },
  frontend: {
    stdout: resolve(runtimeRoot, 'frontend.stdout.log'),
    stderr: resolve(runtimeRoot, 'frontend.stderr.log'),
  },
};

function safetyBlock(message) {
  return new Error(`SAFETY_BLOCK: ${message}`);
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw safetyBlock('the Windows M0 controller can only execute on Windows');
  }
}

function compareVersions(left, right) {
  const a = String(left).replace(/^v/, '').split('.').map(Number);
  const b = String(right).replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function runVersion(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || '').trim();
}

function resolveNpmCli() {
  const candidates = [];
  if (process.env.npm_execpath && /npm-cli\.(?:js|cjs|mjs)$/i.test(process.env.npm_execpath)) {
    candidates.push(process.env.npm_execpath);
  }
  for (const directory of String(process.env.PATH || '').split(delimiter)) {
    if (!directory || !existsSync(resolve(directory, 'npm.cmd'))) continue;
    candidates.push(resolve(directory, 'node_modules/npm/bin/npm-cli.js'));
  }
  candidates.push(resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'));
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw safetyBlock('npm 10.9.2 was not found; install it manually, then rerun Doctor');
  return npmCli;
}

export function doctor({ lite = false } = {}) {
  assertWindows();
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const nodeRange = /^>=(\d+\.\d+\.\d+)\s+<(\d+)$/.exec(String(baseline.node));
  if (!nodeRange
      || compareVersions(process.version, nodeRange[1]) < 0
      || compareVersions(process.version, `${nodeRange[2]}.0.0`) >= 0) {
    throw safetyBlock(`Node ${baseline.node} is required; install it manually`);
  }
  const powerShellVersion = process.env.DSH_WINDOWS_PS_VERSION;
  const minimumPowerShell = String(baseline.powershell).replace(/^>=/, '');
  if (!powerShellVersion || compareVersions(powerShellVersion, minimumPowerShell) < 0) {
    throw safetyBlock(`PowerShell ${baseline.powershell} is required; install it manually`);
  }
  if (!existsSync(packageLockPath)) throw safetyBlock('package-lock.json is missing');

  const npmCli = resolveNpmCli();
  const npmVersion = runVersion(process.execPath, [npmCli, '--version']);
  if (npmVersion !== baseline.npm) throw safetyBlock(`npm ${baseline.npm} is required`);
  if (!lite) {
    const pgEnvironment = withPostgresBinPath(process.env);
    for (const tool of ['psql', 'pg_dump', 'pg_restore']) {
      const version = runVersion(tool, ['--version'], pgEnvironment);
      if (!version) throw safetyBlock(`${tool} is missing; install PostgreSQL ${baseline.postgresql} manually`);
      if (!version.includes(` ${baseline.postgresql}.`)) {
        throw safetyBlock(`${tool} must come from PostgreSQL ${baseline.postgresql}`);
      }
    }
  }
  return { ok: true, node: process.version, npm: npmVersion, postgresqlChecked: !lite };
}

function assertEnvironment() {
  if (!existsSync(envPath)) {
    throw safetyBlock('root .env is missing; run Init to generate a fresh private configuration');
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function install() {
  doctor();
  const before = sha256File(packageLockPath);
  const npmCli = resolveNpmCli();
  const result = spawnSync(process.execPath, [npmCli, 'ci'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('npm ci failed; no dependency fallback was attempted');
  if (sha256File(packageLockPath) !== before) {
    throw safetyBlock('npm ci changed package-lock.json');
  }
  return { installed: true };
}

function runInit() {
  assertEnvironment();
  doctor();
  const result = spawnSync(process.execPath, ['--env-file=.env', initScriptPath], {
    cwd: repoRoot,
    env: createSafeChildEnvironment(process.env),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('local database Init/migrate failed; the database was preserved for diagnosis');
  }
  return { initialized: true };
}

function readState() {
  if (!existsSync(statePath)) return null;
  const original = readFileSync(statePath, 'utf8');
  return parseAndValidateState(original, {
    repoRoot,
    nodePath: process.execPath,
    markers,
  });
}

function writeState(processes) {
  mkdirSync(runtimeRoot, { recursive: true });
  const state = {
    schemaVersion: 1,
    repoRoot,
    createdAt: new Date().toISOString(),
    processes,
  };
  const temporary = `${statePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
}

function processSnapshot(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw safetyBlock('invalid PID requested for snapshot');
  const command = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    'if ($null -eq $p) { exit 3 }',
    '[pscustomobject]@{',
    'ProcessId = $p.ProcessId;',
    "CreationDate = $p.CreationDate.ToUniversalTime().ToString('o');",
    'ExecutablePath = $p.ExecutablePath;',
    'CommandLine = $p.CommandLine',
    '} | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.status === 3) return null;
  if (result.error || result.status !== 0) throw safetyBlock('CIM process identity query failed');
  let row;
  try {
    row = JSON.parse(result.stdout);
  } catch {
    throw safetyBlock('CIM process identity response was invalid');
  }
  return {
    pid: Number(row.ProcessId),
    creationDate: String(row.CreationDate || ''),
    executablePath: String(row.ExecutablePath || ''),
    commandLine: String(row.CommandLine || ''),
  };
}

function classifyState(state) {
  const snapshots = new Map(state.processes.map((record) => [record.pid, processSnapshot(record.pid)]));
  const classification = classifyManagedProcesses(state.processes, snapshots, {
    nodePath: process.execPath,
    markers,
  });
  if (classification.conflicts.length > 0) {
    throw safetyBlock('managed process identity conflict; zero processes were terminated');
  }
  return classification;
}

function managedProcesses() {
  const state = readState();
  if (!state) return [];
  return classifyState(state).live;
}

function portOpen(port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (result) => { socket.destroy(); resolveResult(result); };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) return true;
    } catch {}
    await delay(500);
  }
  return false;
}

function stopFreshChild(child) {
  try {
    if (child?.pid) child.kill();
  } catch {}
}

async function launch(kind) {
  const stdoutFd = openSync(logPaths[kind].stdout, 'a', 0o600);
  const stderrFd = openSync(logPaths[kind].stderr, 'a', 0o600);
  const args = kind === 'backend'
    ? ['--env-file=.env', '--import', tsxImport, markers.backend]
    : [markers.frontend, '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: createSafeChildEnvironment(process.env),
    windowsHide: true,
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);

  let snapshot = null;
  try {
    for (let attempt = 0; attempt < 50 && !snapshot; attempt += 1) {
      await delay(100);
      snapshot = processSnapshot(child.pid);
    }
  } catch (error) {
    stopFreshChild(child);
    throw error;
  }
  if (!snapshot) {
    stopFreshChild(child);
    throw new Error(`${kind} process started but its CIM identity could not be verified`);
  }
  const record = {
    kind,
    pid: child.pid,
    creationDate: snapshot.creationDate,
    executablePath: process.execPath,
    commandMarker: markers[kind],
  };
  const check = classifyManagedProcesses([record], new Map([[record.pid, snapshot]]), {
    nodePath: process.execPath,
    markers,
  });
  if (check.live.length !== 1) {
    stopFreshChild(child);
    throw safetyBlock(`${kind} process identity did not match the fixed command`);
  }
  child.unref();
  return record;
}

function taskkillVerified(records) {
  const firstPass = new Map(records.map((record) => [record.pid, processSnapshot(record.pid)]));
  const firstCheck = classifyManagedProcesses(records, firstPass, { nodePath: process.execPath, markers });
  if (firstCheck.conflicts.length > 0) {
    throw safetyBlock('process identity changed before stop; zero processes were terminated');
  }
  const live = firstCheck.live;
  const immediatePass = new Map(live.map((record) => [record.pid, processSnapshot(record.pid)]));
  const immediateCheck = classifyManagedProcesses(live, immediatePass, { nodePath: process.execPath, markers });
  if (immediateCheck.conflicts.length > 0 || immediateCheck.dead.length > 0) {
    throw safetyBlock('process identity changed immediately before taskkill; zero processes were terminated');
  }
  for (const record of immediateCheck.live) {
    const result = spawnSync('taskkill', ['/PID', String(record.pid), '/T'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`verified process tree ${record.pid} did not stop; /F was not used`);
    }
  }
}

async function stopRecords(records) {
  if (records.length === 0) return;
  taskkillVerified(records);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (records.every((record) => processSnapshot(record.pid) === null)) return;
    await delay(250);
  }
  throw new Error('verified process tree stop timed out; no force escalation was attempted');
}

async function stop() {
  const state = readState();
  if (!state) return { stopped: 0 };
  const classification = classifyState(state);
  await stopRecords(classification.live);
  writeState([]);
  return { stopped: classification.live.length, dead: classification.dead.length };
}

async function start() {
  doctor({ lite: true });
  return runStartSequence({
    managedProcesses,
    portOpen,
    init: runInit,
    launch,
    writeState,
    waitForHttp,
    stopCreated: async (records) => {
      await stopRecords(records);
      writeState([]);
    },
  });
}

async function status() {
  const state = readState();
  const classification = state ? classifyState(state) : { live: [], dead: [], conflicts: [] };
  const backendPort = await portOpen(3000);
  const frontendPort = await portOpen(5173);
  return {
    backend: classification.live.some((item) => item.kind === 'backend') ? 'managed'
      : backendPort ? 'external-port-owner' : 'stopped',
    frontend: classification.live.some((item) => item.kind === 'frontend') ? 'managed'
      : frontendPort ? 'external-port-owner' : 'stopped',
    deadRecords: classification.dead.length,
    url: FRONTEND_URL,
  };
}

function logs() {
  const output = {};
  for (const [kind, paths] of Object.entries(logPaths)) {
    output[kind] = {};
    for (const [stream, path] of Object.entries(paths)) {
      if (!existsSync(path)) {
        output[kind][stream] = 'no log';
        continue;
      }
      const size = statSync(path).size;
      if (size > 10 * 1024 * 1024) throw safetyBlock(`${kind} ${stream} log exceeds the safe display limit`);
      output[kind][stream] = redactSensitiveText(readFileSync(path, 'utf8').split(/\r?\n/).slice(-80).join('\n'));
    }
  }
  return output;
}

function backup() {
  assertEnvironment();
  doctor();
  mkdirSync(backupRoot, { recursive: true });
  const daily = resolve(backupRoot, 'daily');
  const before = new Set(existsSync(daily) ? readdirSync(daily).filter((name) => /^MANIFEST-.*\.json$/.test(name)) : []);
  const result = spawnSync(process.execPath, ['--env-file=.env', backupScriptPath, '--root', backupRoot], {
    cwd: repoRoot,
    env: createSafeChildEnvironment({ ...process.env, BACKUP_ROOT: backupRoot }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('backup failed; inspect the private controller logs');
  const created = readdirSync(daily).filter((name) => /^MANIFEST-.*\.json$/.test(name) && !before.has(name));
  if (created.length !== 1) throw safetyBlock('backup did not create exactly one new MANIFEST');
  const manifest = JSON.parse(readFileSync(resolve(daily, created[0]), 'utf8'));
  if (manifest.summary?.failed !== 0) throw new Error('backup MANIFEST reports failed databases');
  return {
    runId: String(manifest.runId),
    total: Number(manifest.summary.total),
    ok: Number(manifest.summary.ok),
    manifest: created[0],
  };
}

function restoreDrill(request) {
  assertEnvironment();
  const invocation = buildRestoreInvocation(request, { retainOnFailureVerified: true });
  const result = spawnSync(process.execPath, ['--env-file=.env', restoreScriptPath, ...invocation.args], {
    cwd: repoRoot,
    env: createSafeChildEnvironment({ ...process.env, BACKUP_ROOT: backupRoot }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('restore drill failed; the isolated target database was retained for diagnosis');
  }
  return { restored: true, database: request.database, target: request.restoreTarget };
}

function parseCli(argv) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--action') raw.action = value;
    else if (key === '--database') raw.database = value;
    else if (key === '--dump-name') raw.dumpName = value;
    else if (key === '--restore-target') raw.restoreTarget = value;
    else throw safetyBlock(`unknown controller option: ${key}`);
    index += 1;
  }
  return validateControllerRequest(raw);
}

export async function runAction(request) {
  if (request.action === 'Doctor') return doctor();
  if (request.action === 'Install') return install();
  if (request.action === 'Init') return runInit();
  if (request.action === 'Start') return start();
  if (request.action === 'Stop') return stop();
  if (request.action === 'Restart') { await stop(); return start(); }
  if (request.action === 'Status') return status();
  if (request.action === 'Logs') return logs();
  if (request.action === 'Backup') return backup();
  if (request.action === 'RestoreDrill') return restoreDrill(request);
  throw safetyBlock('action dispatch failed');
}

async function main() {
  assertWindows();
  const request = parseCli(process.argv.slice(2));
  const result = await runAction(request);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
