/**
 * ops 工具共享工具函数：DATABASE_URL 加载 / psql 环境 / PostgreSQL bin 定位 / 子进程执行。
 * 模式对齐 packages/contracts/scripts/verify-empty-migration.mjs 与
 * packages/backend/scripts/run-tests-isolated.mjs。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = resolve(opsRoot, '../..');
export const contractsRoot = resolve(projectRoot, 'packages/contracts');
export const contractsEnvPath = resolve(contractsRoot, '.env');
export const prismaBin = resolve(projectRoot, 'node_modules/prisma/build/index.js');
export const schemaPath = resolve(contractsRoot, 'prisma');

/** 读取 packages/contracts/.env 中的键值（沿用 run-tests-isolated.mjs 解析）。 */
export function readEnvValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  const line = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${key}=`));
  if (!line) return undefined;
  let value = line.trim().slice(`${key}=`.length).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || undefined;
}

/** DATABASE_URL 解析顺序：env > contracts/.env。 */
export function loadDatabaseUrl() {
  const value = process.env.DATABASE_URL ?? readEnvValue(contractsEnvPath, 'DATABASE_URL');
  if (!value) throw new Error('SAFETY_BLOCK: DATABASE_URL 未配置');
  return value;
}

/** 把 URL 指向指定数据库（维护连接用 PGDATABASE=postgres）。 */
export function withDatabase(url, databaseName) {
  const next = new URL(url);
  next.pathname = `/${databaseName}`;
  return next;
}

/** 数据库名从 URL 提取（含 URI 解码）。 */
export function databaseNameFromUrl(url) {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) throw new Error('SAFETY_BLOCK: DATABASE_URL 缺少数据库名');
  return name;
}

/** psql/pg_dump 等客户端环境：PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE。 */
export function psqlEnvironment(url, databaseName) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName,
  };
}

/** Windows 下定位 PostgreSQL bin 目录（C:\Program Files\PostgreSQL\<ver>\bin）。 */
export function postgresBinCandidates() {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.ProgramFiles && resolve(process.env.ProgramFiles, 'PostgreSQL'),
    process.env['ProgramFiles(x86)'] && resolve(process.env['ProgramFiles(x86)'], 'PostgreSQL'),
  ].filter(Boolean);
  const dirs = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+(\.\d+)?$/.test(entry.name)) {
        dirs.push(resolve(root, entry.name, 'bin'));
      }
    }
  }
  dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return dirs.filter((dir) => existsSync(dir));
}

/** 把候选目录前置到既有 PATH；调用方负责按优先级排列候选。 */
export function prependPathEntries(existingPath, entries) {
  return [...entries, existingPath].filter(Boolean).join(delimiter);
}

/** 把 PostgreSQL bin 目录前置到 PATH（psql 不在 npm 子进程 PATH 时自行定位）。 */
export function withPostgresBinPath(environment) {
  const bins = postgresBinCandidates();
  if (bins.length === 0) return environment;
  const existingPath = environment.PATH ?? process.env.PATH ?? '';
  return {
    ...environment,
    PATH: prependPathEntries(existingPath, bins),
  };
}

/** spawnSync 封装：返回 result（不抛错，调用方检查 status）。 */
export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    ...options.spawn,
  });
}

/** spawnSync 封装：非 0 退出即抛错（关键步骤用）。 */
export function runRequired(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'no stderr';
    throw new Error(`${command} failed with exit ${result.status}: ${stderr}`);
  }
  return result;
}

/** psql 单条查询（-At 精简输出，返回 stdout 按行数组）。 */
export function psqlQuery(url, databaseName, sql, options = {}) {
  const result = runRequired('psql', ['-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: withPostgresBinPath(psqlEnvironment(url, databaseName)),
    ...options,
  });
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/** SQL 标识符引用（防注入）。 */
export function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

/** SQL 字面量引用（防注入）。 */
export function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** prisma migrate deploy 到指定库（DATABASE_URL 指向 targetUrl）。 */
export function runMigrateDeploy(targetUrl, options = {}) {
  return runRequired(process.execPath, [prismaBin, 'migrate', 'deploy', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    ...options,
  });
}

/** 维护连接（PGDATABASE=postgres）跑一条 psql 命令。 */
export function psqlMaintenance(url, sql, options = {}) {
  return psqlQuery(url, 'postgres', sql, options);
}
