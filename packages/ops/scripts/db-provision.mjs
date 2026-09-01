#!/usr/bin/env node
/**
 * db-provision：新教师数据库建库 + 迁移 + 冒烟（P7 S4，T9 设计 §4.1）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run db-provision -- --database-name teacher_db_xxx
 *   npm -w @teacher-platform/ops run db-provision -- --email teacher@example.com
 *   （--email 时从 TeacherRegistry 读取 databaseName；--database-name 显式优先）
 *
 * 流程：安全校验 → （按需查 TeacherRegistry）→ CREATE DATABASE（维护连接）
 *       → prisma migrate deploy → 冒烟（SELECT 1 + 迁移数 + 表数）→ 失败回滚 DROP。
 *
 * 安全：库名必须 teacher_db_ 前缀白名单；本地 host 红线；维护连接 PGDATABASE=postgres。
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName } from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlEnvironment,
  psqlMaintenance,
  psqlQuery,
  quoteIdentifier,
  quoteLiteral,
  runMigrateDeploy,
  withDatabase,
  withPostgresBinPath,
} from '../lib/pg-utils.mjs';

const SHARED_DB = 'teacher_platform';

function parseArgs(argv) {
  const args = { email: undefined, databaseName: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') args.email = argv[++i];
    else if (arg === '--database-name') args.databaseName = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

function databaseExists(maintenanceUrl, databaseName) {
  const rows = psqlMaintenance(
    maintenanceUrl,
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
  );
  return rows.length > 0;
}

function dropDatabase(maintenanceUrl, databaseName) {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(databaseName)} AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
}

function smokeCheck(targetUrl, databaseName) {
  const rows = psqlQuery(targetUrl, databaseName, 'SELECT 1');
  if (rows.length !== 1 || rows[0] !== '1') throw new Error('smoke SELECT 1 failed');
  const migrationCount = psqlQuery(
    targetUrl,
    databaseName,
    'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  const tables = psqlQuery(
    targetUrl,
    databaseName,
    "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'",
  );
  return { migrations: migrationCount[0], tables: tables[0] };
}

async function main() {
  const { email, databaseName: explicitName } = parseArgs(process.argv.slice(2));
  if (!explicitName && !email) {
    throw new Error('用法: db-provision --database-name <teacher_db_xxx> | --email <teacher@example.com>');
  }

  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
  const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

  let databaseName = explicitName;
  if (!databaseName) {
    const rows = psqlQuery(
      sourceUrl,
      SHARED_DB,
      `SELECT "databaseName" FROM "TeacherRegistry" WHERE "email" = ${quoteLiteral(email)} AND "databaseName" IS NOT NULL`,
    );
    if (rows.length === 0) {
      throw new Error(`TeacherRegistry 中未找到 email=${email} 或未配置 databaseName`);
    }
    databaseName = rows[0];
  }

  assertSafeTeacherDatabaseName(databaseName, sourceDatabaseName);

  const exists = databaseExists(maintenanceUrl, databaseName);
  if (exists) {
    process.stdout.write(`database ${databaseName} already exists\n`);
  } else {
    psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    process.stdout.write(`database ${databaseName} created\n`);
  }

  const targetUrl = withDatabase(sourceUrl, databaseName);
  let created = !exists;
  try {
    runMigrateDeploy(targetUrl);
    const { migrations, tables } = smokeCheck(targetUrl, databaseName);
    process.stdout.write(
      `provision ok: db=${databaseName} migrations=${migrations} tables=${tables}\n`,
    );
    process.stdout.write(JSON.stringify({
      tool: 'db-provision',
      database: databaseName,
      status: 'ok',
      migrations,
      tables,
    }) + '\n');
  } catch (error) {
    // 失败回滚：本次新建的库删掉；既有库不动（可能只是迁移失败，留给 db-migrate-all 重试）
    if (created) {
      try {
        dropDatabase(maintenanceUrl, databaseName);
        process.stdout.write(`rollback: dropped ${databaseName}\n`);
      } catch (rollbackError) {
        process.stderr.write(`rollback failed: ${rollbackError.message}\n`);
      }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs };
