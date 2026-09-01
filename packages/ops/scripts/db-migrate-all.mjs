#!/usr/bin/env node
/**
 * db-migrate-all：遍历全部教师库执行 prisma migrate deploy（P7 S4，T9 设计 §4.2）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run db-migrate-all [--dry-run] [--fail-fast]
 *
 * 流程：共享库枚举 TeacherRegistry.databaseName（distinct 非空）→ 逐项安全校验
 *       → 逐个 migrate deploy；失败 collect（继续下一个），结束汇总 exit 非 0。
 * --dry-run 只列出清单与当前/目标迁移数，不执行。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName } from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlQuery,
  runMigrateDeploy,
  withDatabase,
} from '../lib/pg-utils.mjs';

const SHARED_DB = 'teacher_platform';

export function parseArgs(argv) {
  const args = { dryRun: false, failFast: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--fail-fast') args.failFast = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

/** 枚举 TeacherRegistry 中全部 distinct 非空 databaseName。 */
export function enumerateTeacherDatabases(sourceUrl) {
  const rows = psqlQuery(
    sourceUrl,
    SHARED_DB,
    'SELECT DISTINCT "databaseName" FROM "TeacherRegistry" WHERE "databaseName" IS NOT NULL AND "databaseName" <> \'\' ORDER BY "databaseName"',
  );
  return rows;
}

function currentMigrationCount(targetUrl, databaseName) {
  const rows = psqlQuery(
    targetUrl,
    databaseName,
    'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  return rows[0] ?? '0';
}

function main() {
  const { dryRun, failFast } = parseArgs(process.argv.slice(2));
  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);

  const databases = enumerateTeacherDatabases(sourceUrl);
  databases.forEach((name) => assertSafeTeacherDatabaseName(name, sourceDatabaseName));
  process.stdout.write(`enumerated ${databases.length} teacher databases\n`);

  if (dryRun) {
    for (const name of databases) {
      const targetUrl = withDatabase(sourceUrl, name);
      const current = currentMigrationCount(targetUrl, name);
      process.stdout.write(`[dry-run] ${name} current_migrations=${current}\n`);
    }
    process.stdout.write('dry-run: no migration executed\n');
    return;
  }

  const results = [];
  for (const name of databases) {
    const targetUrl = withDatabase(sourceUrl, name);
    try {
      runMigrateDeploy(targetUrl);
      const current = currentMigrationCount(targetUrl, name);
      results.push({ database: name, status: 'ok', migrations: current });
      process.stdout.write(`migrate ok: ${name}\n`);
    } catch (error) {
      results.push({ database: name, status: 'failed', error: error.message });
      process.stderr.write(`migrate failed: ${name} — ${error.message}\n`);
      if (failFast) break;
    }
  }

  const failed = results.filter((r) => r.status === 'failed');
  process.stdout.write(JSON.stringify({
    tool: 'db-migrate-all',
    total: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    failedDatabases: failed.map((r) => r.database),
  }) + '\n');

  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { currentMigrationCount, main };
