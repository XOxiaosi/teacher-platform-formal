import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertSafeBaseUrl,
  assertSafeTestDatabaseName,
} from './verify-empty-migration.mjs';

const BASELINE_NAME = '00000000000000_current_schema_baseline';
const PENDING_ACTION_MIGRATION = '00000000000001_add_pending_action';
const AGENT_EXECUTION_MIGRATION = '00000000000002_add_agent_execution';
const TEST_DB_PREFIX = 'teacher_platform_migration_test_existing_';
const SOURCE_TABLES = [
  'Student', 'Schedule', 'Lesson', 'AINote', 'Conversation', 'ConversationTurn',
  'Payment', 'DailyReview', 'PushRecord', 'ChangeLog', 'Memo', 'ParentFeedback',
  'StudentSourceRecord', 'StudentRecord', 'AssessmentDetail',
];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(scriptDir, '..');
const projectRoot = resolve(contractsRoot, '../..');
const prismaBin = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const pendingActionMigrationSql = readFileSync(
  resolve(contractsRoot, 'prisma/migrations', PENDING_ACTION_MIGRATION, 'migration.sql'),
  'utf8',
);
const agentExecutionMigrationSql = readFileSync(
  resolve(contractsRoot, 'prisma/migrations', AGENT_EXECUTION_MIGRATION, 'migration.sql'),
  'utf8',
);

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envText = readFileSync(resolve(contractsRoot, '.env'), 'utf8');
  const line = envText.split(/\r?\n/).find((item) => item.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL key missing from packages/contracts/.env');
  let value = line.slice('DATABASE_URL='.length).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function withDatabase(url, databaseName) {
  const next = new URL(url);
  next.pathname = `/${databaseName}`;
  return next;
}

function psqlEnvironment(url) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'no stderr';
    throw new Error(`${command} failed with exit ${result.status}: ${stderr}`);
  }
  return result.stdout.trim();
}

function query(url, sql) {
  return run('psql', ['-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: psqlEnvironment(url),
  });
}

function copyDatabase(sourceUrl, targetUrl) {
  return new Promise((resolveCopy, rejectCopy) => {
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges'], {
      env: psqlEnvironment(sourceUrl),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const restore = spawn('psql', ['-v', 'ON_ERROR_STOP=1'], {
      env: psqlEnvironment(targetUrl),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const errors = [];
    let dumpStatus;
    let restoreStatus;

    dump.stderr.on('data', (chunk) => errors.push(`pg_dump: ${chunk.toString()}`));
    restore.stderr.on('data', (chunk) => errors.push(`psql: ${chunk.toString()}`));
    dump.on('error', rejectCopy);
    restore.on('error', rejectCopy);
    dump.stdout.pipe(restore.stdin);

    const finish = () => {
      if (dumpStatus === undefined || restoreStatus === undefined) return;
      if (dumpStatus !== 0 || restoreStatus !== 0) {
        rejectCopy(new Error(`database copy failed (pg_dump=${dumpStatus}, psql=${restoreStatus}): ${errors.join(' ').trim()}`));
        return;
      }
      resolveCopy();
    };
    dump.on('close', (code) => { dumpStatus = code; finish(); });
    restore.on('close', (code) => { restoreStatus = code; finish(); });
  });
}

function readCounts(url) {
  return Object.fromEntries(SOURCE_TABLES.map((table) => {
    const count = query(url, `SELECT COUNT(*) FROM ${quoteIdentifier(table)}`);
    if (!/^\d+$/.test(count)) throw new Error(`invalid count for ${table}: ${count}`);
    return [table, Number(count)];
  }));
}

function assertSameCounts(before, after) {
  for (const table of SOURCE_TABLES) {
    if (before[table] !== after[table]) {
      throw new Error(`row count changed for ${table}: ${before[table]} -> ${after[table]}`);
    }
  }
}

function readOrphanCounts(url, includePendingAction = false) {
  const checks = {
    scheduleStudent: 'SELECT COUNT(*) FROM "Schedule" s LEFT JOIN "Student" st ON st.id=s."studentId" WHERE s."studentId" IS NOT NULL AND st.id IS NULL',
    scheduleParent: 'SELECT COUNT(*) FROM "Schedule" s LEFT JOIN "Schedule" p ON p.id=s."parentId" WHERE s."parentId" IS NOT NULL AND p.id IS NULL',
    lessonStudent: 'SELECT COUNT(*) FROM "Lesson" l LEFT JOIN "Student" s ON s.id=l."studentId" WHERE s.id IS NULL',
    lessonSchedule: 'SELECT COUNT(*) FROM "Lesson" l LEFT JOIN "Schedule" s ON s.id=l."scheduleId" WHERE s.id IS NULL',
    conversationTurn: 'SELECT COUNT(*) FROM "ConversationTurn" t LEFT JOIN "Conversation" c ON c.id=t."conversationId" WHERE c.id IS NULL',
    paymentStudent: 'SELECT COUNT(*) FROM "Payment" p LEFT JOIN "Student" s ON s.id=p."studentId" WHERE s.id IS NULL',
    feedbackStudent: 'SELECT COUNT(*) FROM "ParentFeedback" f LEFT JOIN "Student" s ON s.id=f."studentId" WHERE s.id IS NULL',
    feedbackLesson: 'SELECT COUNT(*) FROM "ParentFeedback" f LEFT JOIN "Lesson" l ON l.id=f."lessonId" WHERE f."lessonId" IS NOT NULL AND l.id IS NULL',
  };
  if (includePendingAction) {
    checks.pendingActionConversation = 'SELECT COUNT(*) FROM "PendingAction" p LEFT JOIN "Conversation" c ON c.id=p."conversationId" WHERE c.id IS NULL';
    checks.agentExecutionConversation = 'SELECT COUNT(*) FROM "AgentExecution" e LEFT JOIN "Conversation" c ON c.id=e."conversationId" WHERE c.id IS NULL';
  }
  return Object.fromEntries(Object.entries(checks).map(([name, sql]) => [name, Number(query(url, sql))]));
}

function assertNoOrphans(orphanCounts) {
  const failures = Object.entries(orphanCounts).filter(([, count]) => count !== 0);
  if (failures.length > 0) {
    throw new Error(`orphan relations found: ${failures.map(([name, count]) => `${name}=${count}`).join(', ')}`);
  }
}

async function verify() {
  const { url: sourceUrl, databaseName: sourceDatabaseName } = assertSafeBaseUrl(loadDatabaseUrl());
  const testDatabaseName = `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  assertSafeTestDatabaseName(testDatabaseName, sourceDatabaseName);
  const maintenanceUrl = withDatabase(sourceUrl, 'postgres');
  const testUrl = withDatabase(sourceUrl, testDatabaseName);
  let created = false;

  console.log(`source host: ${sourceUrl.hostname}:${sourceUrl.port || '5432'}`);
  console.log(`source database: ${sourceDatabaseName}`);
  console.log(`copy database: ${testDatabaseName}`);

  try {
    run('psql', [
      '-v', 'ON_ERROR_STOP=1', '-c',
      `CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`,
    ], { env: psqlEnvironment(maintenanceUrl) });
    created = true;
    await copyDatabase(sourceUrl, testUrl);
    console.log('online database copy: PASS');

    const beforeCounts = readCounts(testUrl);
    const beforeOrphans = readOrphanCounts(testUrl);
    assertNoOrphans(beforeOrphans);

    // 当前库已由 Prisma 接管：验证 migrate diff 为空（库结构与 schema.prisma 完全一致，即全部迁移已应用）
    const diff = spawnSync(process.execPath, [
      prismaBin,
      'migrate', 'diff',
      '--from-schema-datasource', 'prisma/schema.prisma',
      '--to-schema-datamodel', 'prisma/schema.prisma',
      '--script',
    ], {
      cwd: contractsRoot,
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      encoding: 'utf8',
    });
    if (diff.status !== 0) {
      throw new Error(`expected migration diff failed with exit ${diff.status}: ${diff.stdout.trim()} ${diff.stderr.trim()}`);
    }
    const diffSql = diff.stdout.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (diffSql.length > 0) {
      throw new Error(`source schema is not in sync with schema.prisma; pending diff:\n${diff.stdout.trim()}`);
    }
    console.log('source schema is in sync with schema.prisma (no pending migration): PASS');

    const afterCounts = readCounts(testUrl);
    const afterOrphans = readOrphanCounts(testUrl, true);
    assertSameCounts(beforeCounts, afterCounts);
    assertNoOrphans(afterOrphans);

    const appliedCount = query(
      testUrl,
      'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    if (appliedCount !== '15') throw new Error(`expected 15 applied migrations, got ${appliedCount}`);

    console.log(`source table counts preserved: ${SOURCE_TABLES.length}`);
    console.log(`relation checks preserved: ${Object.keys(afterOrphans).length}`);
    console.log('applied migrations verified: 15');
    console.log('existing database copy verification: PASS');
  } finally {
    if (created) {
      assertSafeTestDatabaseName(testDatabaseName, sourceDatabaseName);
      run('psql', [
        '-v', 'ON_ERROR_STOP=1', '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDatabaseName}' AND pid <> pg_backend_pid()`,
      ], { env: psqlEnvironment(maintenanceUrl) });
      run('psql', [
        '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${quoteIdentifier(testDatabaseName)}`,
      ], { env: psqlEnvironment(maintenanceUrl) });
      console.log('copy database cleanup: PASS');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
