import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
  runMigrateDeploy,
  withDatabase,
} from '../lib/pg-utils.mjs';
import { dumpOneDatabase } from '../scripts/db-backup.mjs';
import {
  assertFileSha256,
  lookupManifestSha,
  parseArgs,
  resolveDumpSource,
  smokeRows,
} from '../scripts/db-restore.mjs';

const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

function randomTeacherDbName(prefix = 'teacher_db_restore_test_') {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

let createdDb;
let tempRoot;

before(async () => {
  createdDb = randomTeacherDbName();
  assertSafeTeacherDatabaseName(createdDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(createdDb)}`);
  runMigrateDeploy(withDatabase(sourceUrl, createdDb));
  tempRoot = await mkdtemp(join(tmpdir(), 'ops-restore-'));
  await mkdir(join(tempRoot, 'daily'), { recursive: true });
});

after(async () => {
  if (createdDb) {
    psqlMaintenance(
      maintenanceUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${createdDb}' AND pid <> pg_backend_pid()`,
    );
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(createdDb)}`);
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test('parseArgs：--database/--from/--target/--force', () => {
  const args = parseArgs(['--database', 'teacher_db_001', '--from', 'x.dump', '--target', 'teacher_db_001_restore_abc', '--force']);
  assert.equal(args.database, 'teacher_db_001');
  assert.equal(args.target, 'teacher_db_001_restore_abc');
  assert.equal(args.force, true);
  assert.throws(() => parseArgs(['--database', 'teacher_db_001']), /用法/);
});

test('resolveDumpSource：BACKUP_ROOT 内文件可解析；.. 穿越与不存在被拒', async () => {
  await writeFile(join(tempRoot, 'daily', 'teacher_db_001_20260830-020000.dump'), Buffer.from('x'));
  const ok = resolveDumpSource(tempRoot, 'daily/teacher_db_001_20260830-020000.dump');
  assert.equal(ok.fileName, 'teacher_db_001_20260830-020000.dump');
  assert.equal(ok.absolute, resolve(tempRoot, 'daily', 'teacher_db_001_20260830-020000.dump'));
  assert.throws(() => resolveDumpSource(tempRoot, '../outside.dump'), /SAFETY_BLOCK/);
  assert.throws(() => resolveDumpSource(tempRoot, 'daily/nope.dump'), /SAFETY_BLOCK/);
});

test('assertFileSha256：匹配通过；不匹配拒绝', async () => {
  const file = join(tempRoot, 'daily', 'sha-test.dump');
  await writeFile(file, Buffer.from('content'));
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update('content').digest('hex');
  assertFileSha256(file, sha); // 通过
  assert.throws(() => assertFileSha256(file, 'f'.repeat(64)), /SAFETY_BLOCK/);
  assert.throws(() => assertFileSha256(file, undefined), /SAFETY_BLOCK.*MANIFEST/i);
});

test('lookupManifestSha：从 MANIFEST 找到对应库的 sha256', async () => {
  const runId = '20260830T020000';
  const manifest = {
    runId,
    databases: [
      { name: 'teacher_db_001', file: 'teacher_db_001_20260830-020000.dump', sha256: 'ab12'.repeat(16) },
    ],
  };
  await writeFile(join(tempRoot, 'daily', `MANIFEST-${runId}.json`), JSON.stringify(manifest));
  const sha = lookupManifestSha(tempRoot, 'teacher_db_001', 'teacher_db_001_20260830-020000.dump');
  assert.equal(sha, 'ab12'.repeat(16));
  const missing = lookupManifestSha(tempRoot, 'teacher_db_002', 'teacher_db_002_x.dump');
  assert.equal(missing, undefined);
});

test('smokeRows：真实 dump→恢复专用库→行数对比（演练分支核心）', async () => {
  // 造数据：给 createdDb 插一个学生（ASCII 数据避免控制台 GBK/UTF8 编码问题）
  psqlQuery(
    sourceUrl,
    createdDb,
    `INSERT INTO "Student" ("id", "teacherId", "name", "grade", "createdAtTs", "updatedAtTs")
     VALUES ('stu_restore_smoke', 'teacher_restore', 'drill student', 'grade-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );

  const dumpPath = join(tempRoot, 'daily', `${createdDb}.dump`);
  const entry = await dumpOneDatabase(sourceUrl, createdDb, 'run-smoke', dumpPath);
  assert.equal(entry.status, 'ok');

  const restoredName = `${createdDb}_restore_${randomBytes(3).toString('hex')}`;
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(restoredName)}`);
  try {
    // 真实恢复：pg_restore -Fc 到恢复专用库，再做行数对比
    const restoredUrl = withDatabase(sourceUrl, restoredName);
    const { run, psqlEnvironment, withPostgresBinPath } = await import('../lib/pg-utils.mjs');
    const cleanUrl = new URL(restoredUrl.toString());
    cleanUrl.search = '';
    cleanUrl.hash = '';
    const restoreResult = run('pg_restore', ['-Fc', '-d', cleanUrl.toString(), dumpPath], {
      env: withPostgresBinPath(psqlEnvironment(restoredUrl, restoredName)),
    });
    assert.equal(restoreResult.status, 0);

    const { report, allMatch } = smokeRows(sourceUrl, createdDb, restoredUrl, restoredName);
    assert.ok(report.some((r) => r.table === 'Student'));
    assert.equal(allMatch, true);
  } finally {
    psqlMaintenance(
      maintenanceUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${restoredName}' AND pid <> pg_backend_pid()`,
    );
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(restoredName)}`);
  }
});

// ─── --force 留证分支（端到端，隔离教师库模拟源库） ───
// 真实覆盖分支会 DROP/CREATE 源库——只对隔离教师库做，不碰共享库/开发库。
let forceDb;
let forceTempRoot;
let forceDumpPath;

before(async () => {
  forceDb = randomTeacherDbName('teacher_db_force_test_');
  assertSafeTeacherDatabaseName(forceDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(forceDb)}`);
  runMigrateDeploy(withDatabase(sourceUrl, forceDb));
  forceTempRoot = await mkdtemp(join(tmpdir(), 'ops-force-'));
  await mkdir(join(forceTempRoot, 'daily'), { recursive: true });

  // 造数据 + 造 dump（dump 内容含 2 行 Student）
  psqlQuery(
    sourceUrl,
    forceDb,
    `INSERT INTO "Student" ("id", "teacherId", "name", "grade", "createdAtTs", "updatedAtTs")
     VALUES ('stu_force_1', 'teacher_force', 'force one', 'grade-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ('stu_force_2', 'teacher_force', 'force two', 'grade-2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  forceDumpPath = join(forceTempRoot, 'daily', `${forceDb}_20260830-020000.dump`);
  const entry = await dumpOneDatabase(sourceUrl, forceDb, 'run-force', forceDumpPath);
  assert.equal(entry.status, 'ok');
  await writeFile(
    join(forceTempRoot, 'daily', 'MANIFEST-20260830T020000.json'),
    JSON.stringify({
      runId: '20260830T020000',
      databases: [{ ...entry, file: `${forceDb}_20260830-020000.dump` }],
    }),
  );
  assert.equal(
    lookupManifestSha(forceTempRoot, forceDb, `${forceDb}_20260830-020000.dump`),
    entry.sha256,
  );

  // 覆盖前在源库再插入第 3 行（模拟"备份后有新数据，源库被破坏需回滚"）
  psqlQuery(
    sourceUrl,
    forceDb,
    `INSERT INTO "Student" ("id", "teacherId", "name", "grade", "createdAtTs", "updatedAtTs")
     VALUES ('stu_force_3', 'teacher_force', 'force three', 'grade-3', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  );
});

after(async () => {
  if (forceDb) {
    psqlMaintenance(
      maintenanceUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${forceDb}' AND pid <> pg_backend_pid()`,
    );
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(forceDb)}`);
  }
  if (forceTempRoot) await rm(forceTempRoot, { recursive: true, force: true });
});

test('真实覆盖分支：无 --force 拒绝；有 --force 先留证 dump 再重建恢复，行数回到 dump 时刻', async () => {
  const { run, runRequired, withDatabase: _withDb } = await import('../lib/pg-utils.mjs');
  const restoreScript = resolve(process.cwd(), 'scripts/db-restore.mjs');
  const env = { ...process.env, BACKUP_ROOT: forceTempRoot };

  // 无 --force → 拒绝且源库未动
  const noForce = run(process.execPath, [restoreScript, '--database', forceDb, '--from', `${forceDb}_20260830-020000.dump`], { env });
  assert.notEqual(noForce.status, 0);
  assert.match(`${noForce.stderr ?? ''}`, /SAFETY_BLOCK.*--force/);

  // 源库未动：仍有 3 行
  const beforeForce = psqlQuery(sourceUrl, forceDb, 'SELECT COUNT(*) FROM "Student"')[0];
  assert.equal(beforeForce, '3');

  // 有 --force：留证 dump 生成 + 重建恢复 → 行数回到 2（dump 时刻）
  const forceRun = run(process.execPath, [restoreScript, '--database', forceDb, '--from', `${forceDb}_20260830-020000.dump`, '--force'], { env });
  assert.equal(forceRun.status, 0, forceRun.stderr);

  // 恢复后行数 = dump 时刻的 2 行（第 3 行被回滚掉）
  const afterForce = psqlQuery(sourceUrl, forceDb, 'SELECT COUNT(*) FROM "Student"')[0];
  assert.equal(afterForce, '2');

  // 留证 dump 已生成（<db>_pre_restore_<ts>.dump）
  const dailyFiles = await readdir(join(forceTempRoot, 'daily'));
  const evidence = dailyFiles.find((name) => name.includes('_pre_restore_'));
  assert.ok(evidence, `expected pre_restore evidence dump, got: ${dailyFiles.join(', ')}`);
});
