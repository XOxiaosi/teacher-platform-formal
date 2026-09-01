#!/usr/bin/env node
/**
 * db-health-check：巡检全部教师库健康状态（P7 S4，T9 设计 §4.3）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run db-health-check [--limit 500] [--auto-migrate]
 *
 * 对每库：SELECT 1（可达性）+ 已应用迁移数统计（finished_at IS NOT NULL AND
 * rolled_back_at IS NULL）。
 * 状态分类：ok / missing（库不存在）/ migration-behind（迁移数 < 10）/ unreachable（连接失败）。
 * 结束输出汇总；存在非 ok 库时 exit 非 0。--auto-migrate 时对 migration-behind 库补跑迁移。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName } from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  psqlQuery,
  quoteLiteral,
  runMigrateDeploy,
  withDatabase,
} from '../lib/pg-utils.mjs';

const SHARED_DB = 'teacher_platform';
const EXPECTED_MIGRATIONS = 10;

export function parseArgs(argv) {
  const args = { limit: 500, autoMigrate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--auto-migrate') args.autoMigrate = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit 必须是正整数');
  return args;
}

/**
 * 对单库跑健康检查；返回 { database, status, detail }。不抛错（异常归为 unreachable）。
 * 库存在性用维护连接（PGDATABASE=postgres）的 pg_database 预检判定，不解析
 * psql 本地化错误文本（Windows 中文 locale 下 "does not exist" 匹配不可靠）。
 */
export function checkOneDatabase(sourceUrl, maintenanceUrl, databaseName) {
  let exists;
  try {
    const rows = psqlMaintenance(
      maintenanceUrl,
      `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
    );
    exists = rows.length > 0;
  } catch (error) {
    return { database: databaseName, status: 'unreachable', detail: `maintenance connection failed: ${error.message.split('\n')[0]}` };
  }
  if (!exists) {
    return { database: databaseName, status: 'missing', detail: 'database does not exist' };
  }

  const targetUrl = withDatabase(sourceUrl, databaseName);
  try {
    const rows = psqlQuery(targetUrl, databaseName, 'SELECT 1');
    if (rows.length !== 1 || rows[0] !== '1') {
      return { database: databaseName, status: 'unreachable', detail: 'SELECT 1 无返回' };
    }
  } catch (error) {
    return { database: databaseName, status: 'unreachable', detail: error.message.split('\n')[0] };
  }

  let migrations;
  try {
    const rows = psqlQuery(
      targetUrl,
      databaseName,
      'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    migrations = rows[0] ?? '0';
  } catch {
    migrations = '0';
  }
  if (Number(migrations) < EXPECTED_MIGRATIONS) {
    return {
      database: databaseName,
      status: 'migration-behind',
      detail: `migrations=${migrations} (expected ${EXPECTED_MIGRATIONS})`,
    };
  }
  return { database: databaseName, status: 'ok', detail: `migrations=${migrations}` };
}

function main() {
  const { limit, autoMigrate } = parseArgs(process.argv.slice(2));
  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
  const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

  const rows = psqlQuery(
    sourceUrl,
    SHARED_DB,
    'SELECT DISTINCT "databaseName" FROM "TeacherRegistry" WHERE "databaseName" IS NOT NULL AND "databaseName" <> \'\' ORDER BY "databaseName"',
  );
  rows.forEach((name) => assertSafeTeacherDatabaseName(name, sourceDatabaseName));

  const targets = rows.slice(0, limit);
  process.stdout.write(`checking ${targets.length} teacher databases (limit=${limit})\n`);

  const results = targets.map((name) => checkOneDatabase(sourceUrl, maintenanceUrl, name));

  if (autoMigrate) {
    for (const result of results) {
      if (result.status !== 'migration-behind') continue;
      process.stdout.write(`auto-migrate: ${result.database}\n`);
      try {
        runMigrateDeploy(withDatabase(sourceUrl, result.database));
        result.status = 'ok';
        result.detail = 'migrated to latest';
      } catch (error) {
        result.status = 'unreachable';
        result.detail = `auto-migrate failed: ${error.message.split('\n')[0]}`;
      }
    }
  }

  for (const result of results) {
    process.stdout.write(`[${result.status}] ${result.database} — ${result.detail}\n`);
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    missing: results.filter((r) => r.status === 'missing').length,
    migrationBehind: results.filter((r) => r.status === 'migration-behind').length,
    unreachable: results.filter((r) => r.status === 'unreachable').length,
  };
  process.stdout.write(JSON.stringify({ tool: 'db-health-check', ...summary }) + '\n');

  if (summary.missing + summary.migrationBehind + summary.unreachable > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { main };
