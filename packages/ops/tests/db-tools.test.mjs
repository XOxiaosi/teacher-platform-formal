import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName } from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  psqlQuery,
  quoteIdentifier,
  runMigrateDeploy,
  withDatabase,
} from '../lib/pg-utils.mjs';
import { checkOneDatabase, parseArgs as parseHealthArgs } from '../scripts/db-health-check.mjs';
import { parseArgs as parseProvisionArgs } from '../scripts/db-provision.mjs';
import { parseArgs as parseMigrateArgs } from '../scripts/db-migrate-all.mjs';

const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

function randomTeacherDbName() {
  return `teacher_db_test_${randomBytes(6).toString('hex')}`;
}

function dropDatabase(name) {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

let createdDb;

before(() => {
  createdDb = randomTeacherDbName();
  assertSafeTeacherDatabaseName(createdDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(createdDb)}`);
});

after(() => {
  if (createdDb) dropDatabase(createdDb);
});

test('db-provision parseArgs：--database-name 与 --email', () => {
  assert.deepEqual(parseProvisionArgs(['--database-name', 'teacher_db_001']), {
    email: undefined,
    databaseName: 'teacher_db_001',
  });
  assert.deepEqual(parseProvisionArgs(['--email', 'a@b.c']), {
    email: 'a@b.c',
    databaseName: undefined,
  });
  assert.throws(() => parseProvisionArgs(['--bogus']), /未知参数/);
});

test('db-migrate-all parseArgs：--dry-run / --fail-fast', () => {
  assert.deepEqual(parseMigrateArgs(['--dry-run']), { dryRun: true, failFast: false });
  assert.deepEqual(parseMigrateArgs(['--fail-fast']), { dryRun: false, failFast: true });
  assert.throws(() => parseMigrateArgs(['--nope']), /未知参数/);
});

test('db-health-check parseArgs：--limit / --auto-migrate', () => {
  assert.deepEqual(parseHealthArgs(['--limit', '10']), { limit: 10, autoMigrate: false });
  assert.deepEqual(parseHealthArgs(['--auto-migrate']), { limit: 500, autoMigrate: true });
  assert.throws(() => parseHealthArgs(['--limit', 'abc']), /正整数/);
});

test('迁移部署到新库后：52 表 / 42 迁移（冒烟口径）', () => {
  const targetUrl = withDatabase(sourceUrl, createdDb);
  runMigrateDeploy(targetUrl);
  const tables = psqlQuery(targetUrl, createdDb, "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'");
  const migrations = psqlQuery(
    targetUrl,
    createdDb,
    'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  assert.equal(tables[0], '52');
  assert.equal(migrations[0], '42');
});

test('db-health-check checkOneDatabase：ok / missing 分类', () => {
  const ok = checkOneDatabase(sourceUrl, maintenanceUrl, createdDb);
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /migrations=42/);

  const missing = checkOneDatabase(sourceUrl, maintenanceUrl, 'teacher_db_definitely_missing_000');
  assert.equal(missing.status, 'missing');
});
