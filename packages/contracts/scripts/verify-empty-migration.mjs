import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { countMigrationFiles } from './migration-count.mjs';

const TEST_DB_PREFIX = 'teacher_platform_migration_test_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(scriptDir, '..');
const projectRoot = resolve(contractsRoot, '../..');
const prismaBin = resolve(projectRoot, 'node_modules/prisma/build/index.js');

export function assertSafeBaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('SAFETY_BLOCK: DATABASE_URL must use PostgreSQL');
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('SAFETY_BLOCK: migration verification only allows a local PostgreSQL host');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) throw new Error('SAFETY_BLOCK: source database name is missing');
  return { url, databaseName };
}

export function assertSafeTestDatabaseName(databaseName, sourceDatabaseName) {
  if (!databaseName.startsWith(TEST_DB_PREFIX)) {
    throw new Error(`SAFETY_BLOCK: test database must start with ${TEST_DB_PREFIX}`);
  }
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('SAFETY_BLOCK: test database name contains unsafe characters');
  }
  if (databaseName === sourceDatabaseName) {
    throw new Error('SAFETY_BLOCK: test database must differ from source database');
  }
}

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

async function verify() {
  const { url: sourceUrl, databaseName: sourceDatabaseName } = assertSafeBaseUrl(loadDatabaseUrl());
  const testDatabaseName = `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  assertSafeTestDatabaseName(testDatabaseName, sourceDatabaseName);

  const maintenanceUrl = withDatabase(sourceUrl, 'postgres');
  const testUrl = withDatabase(sourceUrl, testDatabaseName);
  let created = false;
  let prisma;

  console.log(`source host: ${sourceUrl.hostname}:${sourceUrl.port || '5432'}`);
  console.log(`test database: ${testDatabaseName}`);

  try {
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`], {
      env: psqlEnvironment(maintenanceUrl),
    });
    created = true;

    run(process.execPath, [prismaBin, 'migrate', 'deploy', '--schema', 'prisma'], {
      cwd: contractsRoot,
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
    });

    const tableOutput = run('psql', [
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    ], { env: psqlEnvironment(testUrl) });
    const tables = new Set(tableOutput.split(/\r?\n/).filter(Boolean));
    const expectedTables = [
      'Student', 'Schedule', 'ScheduleParticipant', 'Lesson', 'AINote', 'Conversation', 'ConversationTurn', 'PendingAction', 'AgentExecution',
      'Payment', 'DailyReview', 'PushRecord', 'ChangeLog', 'Memo', 'ParentFeedback',
      'StudentSourceRecord', 'StudentRecord', 'AssessmentDetail', 'CommunicationDetail',
      'FeedbackContextSnapshot', 'FeedbackEvidence',
      'TeacherRegistry', 'TeacherInvitation', 'SessionStore', 'UserRequirement', 'ProviderConfig', 'ProviderUsage',
      'AdminAccount', 'AdminAuditLog', 'ChannelIdentity', 'MediaAsset', 'ChannelMessage', 'ChannelConversation',
      'CaptureEvent', 'CaptureTask', 'CaptureCandidate', 'CaptureDeletionReceipt',
      'LessonLedgerEntry', 'LessonLedgerAdjustmentConfirmation',
      'RecurrenceRule', 'RecurrenceRuleParticipant', 'ScheduleRevision', 'ScheduleCompletionSnapshot',
      'TeacherWorkspacePreference', 'WebMutationReceipt', 'SchedulingWebMutationReceipt',
      '_prisma_migrations',
    ];
    const missing = expectedTables.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`);

    const migrationCount = run('psql', [
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    ], { env: psqlEnvironment(testUrl) });
    const expectedMigrationCount = countMigrationFiles(resolve(contractsRoot, 'prisma/migrations'));
    if (migrationCount !== String(expectedMigrationCount)) throw new Error(`expected ${expectedMigrationCount} applied migrations, got ${migrationCount}`);

    prisma = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } });
    const student = await prisma.student.create({
      data: { teacherId: 'migration-smoke-teacher', name: '迁移验证学生', grade: '高一' },
    });
    const persisted = await prisma.student.findUnique({ where: { id: student.id } });
    if (!persisted || persisted.teacherId !== 'migration-smoke-teacher') {
      throw new Error('Prisma CRUD smoke verification failed');
    }
    const conversation = await prisma.conversation.create({
      data: { teacherId: 'migration-smoke-teacher' },
    });
    const pendingAction = await prisma.pendingAction.create({
      data: {
        teacherId: 'migration-smoke-teacher',
        conversationId: conversation.id,
        toolCallId: 'migration-smoke-tool-call',
        actionName: 'students.updateStatus',
        targetType: 'Student',
        targetId: student.id,
        parameters: { studentId: student.id, status: 'paused' },
        afterSummary: '将学生状态更新为 paused',
        expiresAtTs: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    if (pendingAction.status !== 'pending') throw new Error('PendingAction CRUD smoke verification failed');
    const userTurn = await prisma.conversationTurn.create({
      data: {
        teacherId: 'migration-smoke-teacher',
        conversationId: conversation.id,
        role: 'user',
        content: 'migration smoke',
      },
    });
    const execution = await prisma.agentExecution.create({
      data: {
        teacherId: 'migration-smoke-teacher',
        conversationId: conversation.id,
        clientRequestId: 'migration-smoke-request',
        requestFingerprint: 'migration-smoke-fingerprint',
        userTurnId: userTurn.id,
      },
    });
    if (execution.status !== 'running') throw new Error('AgentExecution CRUD smoke verification failed');
    await prisma.agentExecution.delete({ where: { id: execution.id } });
    await prisma.conversationTurn.delete({ where: { id: userTurn.id } });
    await prisma.pendingAction.delete({ where: { id: pendingAction.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
    await prisma.student.delete({ where: { id: student.id } });

    console.log(`tables verified: ${expectedTables.length}`);
    console.log(`applied migrations verified: ${expectedMigrationCount}`);
    console.log('Prisma CRUD smoke: PASS');
    console.log('empty database migrate deploy: PASS');
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assertSafeTestDatabaseName(testDatabaseName, sourceDatabaseName);
      run('psql', [
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDatabaseName}' AND pid <> pg_backend_pid()`,
      ], { env: psqlEnvironment(maintenanceUrl) });
      run('psql', [
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `DROP DATABASE ${quoteIdentifier(testDatabaseName)}`,
      ], { env: psqlEnvironment(maintenanceUrl) });
      console.log('test database cleanup: PASS');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
