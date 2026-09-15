#!/usr/bin/env node
/** Persistent, loopback-only synthetic acceptance server. Never borrows DATABASE_URL or .env. */
import { createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv[2];
if (!requested || !isAbsolute(requested)) throw new Error('请指定源码树外的绝对数据目录。');
const directory = resolve(requested);
if (directory === root || directory.startsWith(root + '/') || directory === '/' || directory.length < 20) throw new Error('拒绝不安全的数据目录。');
const marker = join(directory, 'connected-local.json');
const run = (command, args, env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} 执行失败，数据目录保留供排查。`);
};
const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});
const listening = (port) => new Promise((resolveListening) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolveListening(true); });
  socket.once('error', () => { socket.destroy(); resolveListening(false); });
});
const version = spawnSync('initdb', ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || !/PostgreSQL\) 17\./.test(version.stdout)) throw new Error('本地验收需要 PostgreSQL 17。');
if (await listening(3001)) throw new Error('3001 已占用，未停止或覆盖现有服务。');
let configuration;
if (existsSync(directory)) {
  if (!existsSync(marker)) throw new Error('已有目录没有本项目验收标记，拒绝使用。');
  configuration = JSON.parse(readFileSync(marker, 'utf8'));
  if (configuration.kind !== 'teacher-platform-connected-local/v1' || configuration.directory !== realpathSync(directory)) throw new Error('验收标记不匹配。');
} else {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  configuration = { kind: 'teacher-platform-connected-local/v1', directory: realpathSync(directory), port: await freePort(), encryptionKey: randomBytes(32).toString('hex'), actionSecret: randomBytes(32).toString('hex') };
  writeFileSync(marker, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
}
if (!Number.isInteger(configuration.port) || configuration.port < 1024 || [5432, 55432, 3000, 3001, 5173].includes(configuration.port)) throw new Error('数据库端口不安全。');
const env = {
  PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', NODE_ENV: 'development',
  DATABASE_URL: `postgresql://postgres@127.0.0.1:${configuration.port}/teacher_platform`,
  ENCRYPTION_KEY: configuration.encryptionKey, ACTION_TOKEN_SECRET: configuration.actionSecret,
  // A distinct, stable key for local configuration storage; never load provider credentials from .env.
  PROVIDER_KEY_ENCRYPTION_KEY: createHmac('sha256', Buffer.from(configuration.encryptionKey, 'hex')).update('teacher-platform/provider-config/v1').digest('hex'),
  LOCAL_SAFE_MODE: 'true', PLATFORM_SERVICES_ENABLED: 'false', WECHAT_ILINK_ENABLED: 'false',
  LISTEN_HOST: '127.0.0.1', PORT: '3001', LOG_LEVEL: 'error', STORAGE_BACKEND: 'local',
};
const pgEnv = { ...env, PGHOST: '127.0.0.1', PGPORT: String(configuration.port), PGUSER: 'postgres', PGDATABASE: 'postgres' };
const pgdata = join(directory, 'postgres');
const fresh = !existsSync(join(pgdata, 'PG_VERSION'));
if (fresh) run('initdb', ['--no-locale', '--encoding=UTF8', '--auth=trust', '--username=postgres', '--pgdata', pgdata], env);
if (await listening(configuration.port)) throw new Error('验收数据库端口仍在运行；请从原启动终端停止后再启动，未强制结束。');
run('pg_ctl', ['start', '--wait', '--timeout', '30', '--pgdata', pgdata, '--log', join(directory, 'postgres.log'), '--options', `-h 127.0.0.1 -p ${configuration.port}`, '--silent'], env);
let child;
let stopping = false;
function stop() { if (!stopping) { stopping = true; child?.kill('SIGTERM'); } }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  if (fresh) run('createdb', ['teacher_platform'], pgEnv);
  run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(root, 'packages/contracts/prisma')], env);
  run(process.execPath, [join(root, 'scripts/seed-connected-local.mjs')], env);
  child = spawn(process.execPath, [join(root, 'packages/backend/dist/index.js')], { cwd: root, env, stdio: 'inherit' });
  console.log(`本地实测后端：http://127.0.0.1:3001；持久数据：${directory}；仅合成验收，外部服务关闭。`);
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (value) => resolveExit(value ?? 0)); });
  process.exitCode = code;
} finally {
  run('pg_ctl', ['stop', '--wait', '--timeout', '30', '--pgdata', pgdata, '--mode', 'fast', '--silent'], env);
  console.log('验收服务已停止；数据和加密配置保留，使用相同目录可以恢复。');
}
