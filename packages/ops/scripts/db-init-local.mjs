#!/usr/bin/env node
/**
 * Windows M0 本地共享库初始化：仅允许本机 PostgreSQL 的 teacher_platform。
 * 不读取文件、不创建样例数据、不执行 DROP/reset/push/terminate；迁移失败保留现场。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseUrl, SHARED_DB_NAME } from '../lib/db-safety.mjs';
import {
  psqlMaintenance,
  quoteIdentifier,
  quoteLiteral,
  runMigrateDeploy,
  withDatabase,
} from '../lib/pg-utils.mjs';

export function assertSafeInitDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new Error('SAFETY_BLOCK: root .env must provide DATABASE_URL');
  }
  const parsed = assertSafeBaseUrl(databaseUrl);
  if (parsed.databaseName !== SHARED_DB_NAME) {
    throw new Error(`SAFETY_BLOCK: Init only allows the exact shared database ${SHARED_DB_NAME}`);
  }
  return parsed;
}

export function initializeLocalSharedDatabase({
  databaseUrl,
  queryMaintenance = psqlMaintenance,
  migrateDeploy = runMigrateDeploy,
} = {}) {
  const { url, databaseName } = assertSafeInitDatabaseUrl(databaseUrl);
  const maintenanceUrl = withDatabase(url, 'postgres');
  const existing = queryMaintenance(
    maintenanceUrl,
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
  );
  const created = existing.length === 0;
  if (created) {
    queryMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  }

  const targetUrl = withDatabase(url, databaseName);
  migrateDeploy(targetUrl);
  return { created, migrated: true };
}

function main() {
  const result = initializeLocalSharedDatabase({ databaseUrl: process.env.DATABASE_URL });
  process.stdout.write(`${JSON.stringify({
    tool: 'db-init-local',
    database: SHARED_DB_NAME,
    created: result.created,
    migrated: result.migrated,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
