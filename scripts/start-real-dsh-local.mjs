#!/usr/bin/env node
/** Explicit real-model smoke entry. New synthetic DB only; never reads .env or ambient credentials.
 * node scripts/start-real-dsh-local.mjs /absolute/new-data-dir --runtime-root /absolute/dsh \
 *   --api-key-file /absolute/external-key.env --port 3002 --db-port 55433
 * Starting this server does not itself send a model request. Teacher messages can incur real usage.
 */
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { buildRealDshLocalEnvironment, parseRealDshLocalArgs, validateRealDshLocalOptions } from './real-dsh-local-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, env, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('本地启动步骤失败；合成目录保留供检查。');
}
async function assertFreePort(port) {
  const server = net.createServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', () => reject(new Error(`端口 ${port} 不可用，未停止任何现有服务。`)));
    server.listen(port, '127.0.0.1', () => server.close(resolveReady));
  });
}

export async function startRealDshLocal(args = process.argv.slice(2)) {
  const config = validateRealDshLocalOptions(parseRealDshLocalArgs(args), root);
  const { DSH_PINNED_COMMIT } = await import(pathToFileURL(join(root, 'packages/backend/dist/app/teaching-runtime/real-dsh-runtime.js')).href);
  const head = execFileSync('git', ['-C', config.runtimeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (head !== DSH_PINNED_COMMIT) throw new Error('DSH checkout 不是已核验的固定版本。');
  const version = spawnSync('initdb', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } });
  if (version.status !== 0 || !/PostgreSQL\) 17\./.test(version.stdout)) throw new Error('本地验收需要 PostgreSQL 17。');
  await assertFreePort(config.serverPort);
  await assertFreePort(config.databasePort);
  // Atomic mkdir: an existing directory, including a raced symlink, is never accepted.
  mkdirSync(config.directory, { mode: 0o700 });
  const keys = { encryptionKey: randomBytes(32).toString('hex'), actionSecret: randomBytes(32).toString('hex') };
  writeFileSync(join(config.directory, 'real-dsh-local.json'), JSON.stringify({ kind: 'teacher-platform-real-dsh-local/v1', ...config, ...keys }), { flag: 'wx', mode: 0o600 });
  const env = buildRealDshLocalEnvironment(config, keys);
  const bootstrap = Object.fromEntries(Object.entries(env).filter(([key]) => !['DSH_RUNTIME_ENABLED', 'DSH_RUNTIME_ROOT', 'DSH_SESSION_ROOT', 'DEEPSEEK_API_KEY_FILE'].includes(key)));
  const pgdata = join(config.directory, 'postgres');
  const pgEnv = { ...bootstrap, PGHOST: '127.0.0.1', PGPORT: String(config.databasePort), PGUSER: 'postgres', PGDATABASE: 'postgres' };
  run('initdb', ['--no-locale', '--encoding=UTF8', '--auth=trust', '--username=postgres', '--pgdata', pgdata], bootstrap);
  // No shared Unix socket; all clients use the isolated loopback TCP port.
  run('pg_ctl', ['start', '--wait', '--timeout', '30', '--pgdata', pgdata, '--log', join(config.directory, 'postgres.log'), '--options', `-h 127.0.0.1 -p ${config.databasePort} -c unix_socket_directories=`, '--silent'], bootstrap);
  let child;
  let stopping = false;
  const stop = () => { stopping = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    run('createdb', ['teacher_platform'], pgEnv);
    run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(root, 'packages/contracts/prisma')], bootstrap, config.directory);
    run(process.execPath, [join(root, 'scripts/seed-connected-local.mjs')], bootstrap, config.directory);
    if (stopping) return;
    child = spawn(process.execPath, [join(root, 'packages/backend/dist/index.js')], { cwd: config.directory, env, stdio: 'inherit' });
    console.log(`真实 DSH 本地验收：http://127.0.0.1:${config.serverPort}；仅合成资料；发送教学消息可能产生模型费用。`);
    process.exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code) => resolveExit(code ?? 0)); });
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    run('pg_ctl', ['stop', '--wait', '--timeout', '30', '--pgdata', pgdata, '--mode', 'fast', '--silent'], bootstrap);
    console.log('本地实例已停止；合成资料保留。下次启动须使用全新目录。');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRealDshLocal().catch(() => { console.error('真实 DSH 本地启动失败。请核对独立目录、固定版本、文件路径与空闲端口；未读取其他环境配置。'); process.exitCode = 1; });
}
