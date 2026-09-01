import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName } from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  psqlQuery,
  quoteIdentifier,
  quoteLiteral,
  runMigrateDeploy,
  withDatabase,
} from '../lib/pg-utils.mjs';
import {
  appendRegistryLog,
  assertSafeMediaTeacherId,
  backupEvidence,
  cleanupMediaEvidence,
  deleteTeacherRecord,
  dropTeacherDatabase,
  main,
  parseArgs,
  preflight,
  resolveMediaRoot,
} from '../scripts/deactivate-teacher.mjs';

const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

const TEACHER_ID = `teacher_deact_test_${randomBytes(6).toString('hex')}`;
const TEACHER_EMAIL = `${TEACHER_ID}@example.com`;
const SESSION_ID = `sess_deact_${randomBytes(6).toString('hex')}`;

let createdDb;
let tempRoot;
let deactivatedRoot;

before(async () => {
  // 防御：清理本测试可能残留的同前缀数据（上次中断/失败残留）
  try {
    psqlQuery(
      sourceUrl,
      'teacher_platform',
      `DELETE FROM "SessionStore" WHERE "id" LIKE 'sess_deact_%'`,
    );
  } catch { /* 无残留 */ }
  try {
    psqlQuery(
      sourceUrl,
      'teacher_platform',
      `DELETE FROM "TeacherRegistry" WHERE "id" LIKE 'teacher_deact_test_%' OR "id" LIKE 'teacher_deact_tmp_%'`,
    );
  } catch { /* 无残留 */ }

  createdDb = `teacher_db_deact_${randomBytes(6).toString('hex')}`;
  assertSafeTeacherDatabaseName(createdDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(createdDb)}`);
  runMigrateDeploy(withDatabase(sourceUrl, createdDb));

  // 业务数据 + 会话 + 注册记录
  psqlQuery(
    sourceUrl,
    createdDb,
    `INSERT INTO "Student" ("id","teacherId","name","grade","currentStatus","createdAtTs","updatedAtTs")
     VALUES ('deact_s1','${TEACHER_ID}','Deact One','grade-1','active',now(),now())`,
  );
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "TeacherRegistry" ("id","email","passwordHash","displayName","status","databaseName","createdAtTs","updatedAtTs")
     VALUES (${quoteLiteral(TEACHER_ID)}, ${quoteLiteral(TEACHER_EMAIL)}, 'scrypt:DEACT-HASH', 'Deact Teacher', 'active',
             ${quoteLiteral(createdDb)}, now(), now())`,
  );
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "SessionStore" ("id","tokenHash","teacherId","expiresAtTs","createdAtTs","updatedAtTs")
     VALUES (${quoteLiteral(SESSION_ID)}, 'tok_${SESSION_ID}','${TEACHER_ID}','2099-01-01T00:00:00.000Z',now(),now())`,
  );

  tempRoot = await mkdtemp(join(tmpdir(), 'ops-deact-'));
  deactivatedRoot = resolve(tempRoot, 'backups', 'deactivated');
  await mkdir(deactivatedRoot, { recursive: true });
});

after(async () => {
  // 清理注册记录（若仍存在）与隔离库
  try {
    psqlQuery(
      sourceUrl,
      'teacher_platform',
      `DELETE FROM "TeacherRegistry" WHERE "id" LIKE 'teacher_deact_test_%' OR "id" LIKE 'teacher_deact_tmp_%'`,
    );
  } catch { /* 已清理 */ }
  try {
    psqlQuery(
      sourceUrl,
      'teacher_platform',
      `DELETE FROM "SessionStore" WHERE "id" LIKE 'sess_deact_%' OR "teacherId" LIKE 'teacher_deact_%'`,
    );
  } catch { /* 已清理 */ }
  const dbExists = psqlQuery(
    sourceUrl,
    'postgres',
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(createdDb)}`,
  );
  if (dbExists.length > 0) {
    psqlMaintenance(
      maintenanceUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${createdDb}' AND pid <> pg_backend_pid()`,
    );
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(createdDb)}`);
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test('parseArgs：--teacher-id 必填；--dry-run / --confirm / --cleanup-media 解析', () => {
  const args = parseArgs(['--teacher-id', 't1', '--dry-run', '--confirm', '--cleanup-media']);
  assert.equal(args.teacherId, 't1');
  assert.equal(args.dryRun, true);
  assert.equal(args.confirm, true);
  assert.equal(args.cleanupMedia, true);
  assert.throws(() => parseArgs([]), /用法/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
});

test('preflight：activeSessions 计数、无 pending 动作（业务前置检查）', () => {
  const pre = preflight(sourceUrl, createdDb, TEACHER_ID);
  assert.equal(pre.activeSessions, 1); // sess_deact_1 未过期
  assert.equal(pre.pendingActions, 0);
  assert.equal(pre.runningExecutions, 0);
});

test('backupEvidence：产出教师库 + 共享库 dump 到 deactivated 目录（双校验）', async () => {
  const result = await backupEvidence(sourceUrl, createdDb, deactivatedRoot);
  assert.ok(result.teacherDump);
  assert.ok(result.sharedDump);
  const files = await readdir(deactivatedRoot);
  assert.ok(files.includes(result.teacherDump));
  assert.ok(files.includes(result.sharedDump));
  // dump 文件非空（PGDMP 魔数）
  const dumpPath = resolve(deactivatedRoot, result.teacherDump);
  const head = readFileSync(dumpPath).subarray(0, 5).toString('latin1');
  assert.equal(head, 'PGDMP');
});

test('appendRegistryLog：登记簿 JSON 行追加', async () => {
  const logPath = await appendRegistryLog(deactivatedRoot, {
    ts: '2026-08-30T02:00:00.000Z',
    teacherId: TEACHER_ID,
    email: TEACHER_EMAIL,
    action: 'deactivate',
  });
  assert.ok(existsSync(logPath));
  const line = readFileSync(logPath, 'utf8').trim().split('\n').pop();
  const entry = JSON.parse(line);
  assert.equal(entry.teacherId, TEACHER_ID);
  assert.equal(entry.action, 'deactivate');
});

// ---- P8 t8 缺口2：媒体清理（--cleanup-media） ----

test('assertSafeMediaTeacherId：拒绝路径穿越与非法字符', () => {
  assert.equal(assertSafeMediaTeacherId('teacher_abc-123'), 'teacher_abc-123');
  assert.throws(() => assertSafeMediaTeacherId('../../etc/passwd'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeMediaTeacherId('a/b'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeMediaTeacherId('a b'), /SAFETY_BLOCK/);
});

test('cleanupMediaEvidence：先留证后删（tar + sha256 + registry.log + 物理删除）', async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'ops-media-'));
  const deactRoot = resolve(mediaRoot, 'backups', 'deactivated');
  const teacherId = `teacher_media_${randomBytes(4).toString('hex')}`;

  // 造媒体文件：media/<teacherId>/<assetId>/original
  const assetDir = resolve(mediaRoot, 'media', teacherId, 'asset_1');
  await mkdir(assetDir, { recursive: true });
  const fileContent = Buffer.from('fake-png-bytes-123');
  await writeFile(resolve(assetDir, 'original'), fileContent);

  const result = await cleanupMediaEvidence(mediaRoot, teacherId, deactRoot);
  assert.equal(result.skipped, false);
  assert.equal(result.archived, true);
  assert.ok(result.tarFile);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

  // tar 存在且非空
  const tarPath = resolve(deactRoot, result.tarFile);
  assert.ok(existsSync(tarPath));
  const tarStat = (await import('node:fs/promises')).stat(tarPath);
  assert.ok((await tarStat).size > 0);

  // 媒体目录已物理删除
  assert.ok(!existsSync(resolve(mediaRoot, 'media', teacherId)));

  // registry.log 有 media-cleanup 条目
  const log = readFileSync(resolve(deactRoot, 'registry.log'), 'utf8');
  assert.ok(log.includes('media-cleanup'));
  assert.ok(log.includes(teacherId));
  assert.ok(log.includes(result.sha256));

  await rm(mediaRoot, { recursive: true, force: true });
});

test('cleanupMediaEvidence：无媒体目录 → skipped 不失败（幂等）', async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'ops-media-empty-'));
  const deactRoot = resolve(mediaRoot, 'backups', 'deactivated');
  const result = await cleanupMediaEvidence(mediaRoot, 'teacher_no_media', deactRoot);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-media-dir');
  assert.equal(result.tarFile, null);
  await rm(mediaRoot, { recursive: true, force: true });
});

test('resolveMediaRoot：MEDIA_STORAGE_ROOT env 优先，缺省项目根 .data', () => {
  const original = process.env.MEDIA_STORAGE_ROOT;
  try {
    delete process.env.MEDIA_STORAGE_ROOT;
    assert.ok(resolveMediaRoot().endsWith('.data'));
    process.env.MEDIA_STORAGE_ROOT = 'C:/custom/media-root';
    assert.equal(resolveMediaRoot(), resolve('C:/custom/media-root'));
  } finally {
    if (original === undefined) delete process.env.MEDIA_STORAGE_ROOT;
    else process.env.MEDIA_STORAGE_ROOT = original;
  }
});

test('confirm + --cleanup-media 全流程：媒体留证删除 + 库/记录/会话删除 + 登记簿', async () => {
  const mediaTeacherId = `teacher_media_full_${randomBytes(4).toString('hex')}`;
  const mediaDb = `teacher_db_media_${randomBytes(6).toString('hex')}`;
  assertSafeTeacherDatabaseName(mediaDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(mediaDb)}`);
  runMigrateDeploy(withDatabase(sourceUrl, mediaDb));
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "TeacherRegistry" ("id","email","passwordHash","displayName","status","databaseName","createdAtTs","updatedAtTs")
     VALUES (${quoteLiteral(mediaTeacherId)}, ${quoteLiteral(mediaTeacherId + '@media.com')}, 'scrypt:M', 'Media Teacher', 'active',
             ${quoteLiteral(mediaDb)}, now(), now())`,
  );

  const mediaRoot = await mkdtemp(join(tmpdir(), 'ops-media-full-'));
  const assetDir = resolve(mediaRoot, 'media', mediaTeacherId, 'asset_9');
  await mkdir(assetDir, { recursive: true });
  await writeFile(resolve(assetDir, 'original'), Buffer.from('media-full-evidence'));

  const originalArgv = process.argv;
  const originalBackupRoot = process.env.BACKUP_ROOT;
  const originalMediaRoot = process.env.MEDIA_STORAGE_ROOT;
  process.env.BACKUP_ROOT = resolve(mediaRoot, 'backups');
  process.env.MEDIA_STORAGE_ROOT = mediaRoot;
  process.argv = ['node', 'deactivate-teacher.mjs', '--teacher-id', mediaTeacherId, '--confirm', '--cleanup-media'];
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    if (originalBackupRoot === undefined) delete process.env.BACKUP_ROOT;
    else process.env.BACKUP_ROOT = originalBackupRoot;
    if (originalMediaRoot === undefined) delete process.env.MEDIA_STORAGE_ROOT;
    else process.env.MEDIA_STORAGE_ROOT = originalMediaRoot;
  }

  // 库已 DROP、记录已删
  const dbExists = psqlQuery(
    sourceUrl,
    'postgres',
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(mediaDb)}`,
  );
  assert.equal(dbExists.length, 0);
  const account = psqlQuery(
    sourceUrl,
    'teacher_platform',
    `SELECT "id" FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(mediaTeacherId)}`,
  );
  assert.equal(account.length, 0);

  // 媒体目录已删、tar 留证存在、登记簿含 media-cleanup
  assert.ok(!existsSync(resolve(mediaRoot, 'media', mediaTeacherId)));
  const deactivatedFiles = await readdir(resolve(mediaRoot, 'backups', 'deactivated'));
  assert.ok(deactivatedFiles.some((f) => f.startsWith(`media-${mediaTeacherId}-`) && f.endsWith('.tar')));
  const log = readFileSync(resolve(mediaRoot, 'backups', 'deactivated', 'registry.log'), 'utf8');
  assert.ok(log.includes('media-cleanup'));
  assert.ok(log.includes(mediaTeacherId));

  await rm(mediaRoot, { recursive: true, force: true });
});

test('安全拒绝：--confirm 缺失（非 dry-run）→ SAFETY_BLOCK', async () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'deactivate-teacher.mjs', '--teacher-id', TEACHER_ID];
  try {
    await assert.rejects(() => main(), /SAFETY_BLOCK/);
  } finally {
    process.argv = originalArgv;
  }
});

test('dropTeacherDatabase：共享库禁删；非 teacher_db_ 前缀拒绝', () => {
  assert.throws(() => dropTeacherDatabase(maintenanceUrl, 'teacher_platform', sourceDatabaseName), /SAFETY_BLOCK/);
  assert.throws(() => dropTeacherDatabase(maintenanceUrl, 'evil_db', sourceDatabaseName), /SAFETY_BLOCK/);
});

test('dry-run：只报告不执行（库/记录/会话均保留）', async () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'deactivate-teacher.mjs', '--teacher-id', TEACHER_ID, '--dry-run'];
  try {
    await main();
  } finally {
    process.argv = originalArgv;
  }
  // 记录仍在、库仍在、会话仍在
  const account = psqlQuery(
    sourceUrl,
    'teacher_platform',
    `SELECT "id" FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(TEACHER_ID)}`,
  );
  assert.equal(account.length, 1);
  const dbExists = psqlQuery(
    sourceUrl,
    'postgres',
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(createdDb)}`,
  );
  assert.equal(dbExists.length, 1);
});

test('confirm 全流程：备份留证 → DROP 库 → 删记录 → 登记簿；断言库/记录/会话已删', async () => {
  const originalArgv = process.argv;
  const originalBackupRoot = process.env.BACKUP_ROOT;
  process.env.BACKUP_ROOT = resolve(tempRoot, 'backups');
  process.argv = ['node', 'deactivate-teacher.mjs', '--teacher-id', TEACHER_ID, '--confirm'];
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    if (originalBackupRoot === undefined) delete process.env.BACKUP_ROOT;
    else process.env.BACKUP_ROOT = originalBackupRoot;
  }

  // 独立库已 DROP
  const dbExists = psqlQuery(
    sourceUrl,
    'postgres',
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(createdDb)}`,
  );
  assert.equal(dbExists.length, 0);

  // TeacherRegistry 记录已删
  const account = psqlQuery(
    sourceUrl,
    'teacher_platform',
    `SELECT "id" FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(TEACHER_ID)}`,
  );
  assert.equal(account.length, 0);

  // 会话已删
  const sessions = psqlQuery(
    sourceUrl,
    'teacher_platform',
    `SELECT "id" FROM "SessionStore" WHERE "teacherId" = ${quoteLiteral(TEACHER_ID)}`,
  );
  assert.equal(sessions.length, 0);

  // 备份留证存在
  const files = await readdir(deactivatedRoot);
  assert.ok(files.some((f) => f.startsWith('teacher_db_deact_') && f.endsWith('.dump')));
  assert.ok(files.some((f) => f.startsWith('teacher_platform_') && f.endsWith('.dump')));

  // 登记簿写入
  const log = readFileSync(resolve(deactivatedRoot, 'registry.log'), 'utf8');
  assert.ok(log.includes(TEACHER_ID));
});

test('幂等：已注销的教师再次注销 → 明确错误', async () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'deactivate-teacher.mjs', '--teacher-id', TEACHER_ID, '--confirm'];
  try {
    await assert.rejects(() => main(), /教师不存在/);
  } finally {
    process.argv = originalArgv;
  }
});

test('deleteTeacherRecord：直接删除函数（含会话清理）', () => {
  // 用临时教师验证（after 兜底清理）
  const tempId = `teacher_deact_tmp_${randomBytes(4).toString('hex')}`;
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "TeacherRegistry" ("id","email","passwordHash","displayName","status","databaseName","createdAtTs","updatedAtTs")
     VALUES (${quoteLiteral(tempId)}, ${quoteLiteral(tempId + '@tmp.com')}, 'h', 'Tmp', 'active', 'teacher_platform', now(), now())`,
  );
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "SessionStore" ("id","tokenHash","teacherId","expiresAtTs","createdAtTs","updatedAtTs")
     VALUES ('sess_tmp_${tempId}','tok_${tempId}','${tempId}','2099-01-01T00:00:00.000Z',now(),now())`,
  );
  const deleted = deleteTeacherRecord(sourceUrl, tempId);
  assert.equal(deleted, true);
  const sessions = psqlQuery(
    sourceUrl,
    'teacher_platform',
    `SELECT "id" FROM "SessionStore" WHERE "teacherId" = ${quoteLiteral(tempId)}`,
  );
  assert.equal(sessions.length, 0);
});
