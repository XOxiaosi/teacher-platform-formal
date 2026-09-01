import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
import {
  buildDumpFileName,
  collectMediaManifest,
  dumpOneDatabase,
  enumerateBackupDatabases,
  hardenBackupPermissions,
  parseArgs,
  resolveMediaRoot,
} from '../scripts/db-backup.mjs';

const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

function randomTeacherDbName() {
  return `teacher_db_backup_test_${randomBytes(6).toString('hex')}`;
}

let createdDb;
let tempRoot;

before(async () => {
  createdDb = randomTeacherDbName();
  assertSafeTeacherDatabaseName(createdDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(createdDb)}`);
  runMigrateDeploy(withDatabase(sourceUrl, createdDb));
  tempRoot = await mkdtemp(join(tmpdir(), 'ops-backup-'));
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

test('parseArgs：--root / --parallel / --force', () => {
  const args = parseArgs(['--root', 'C:/backups', '--parallel', '4', '--force']);
  assert.equal(args.root, 'C:/backups');
  assert.equal(args.parallel, 4);
  assert.equal(args.force, true);
  assert.throws(() => parseArgs(['--parallel', '0']), /1\.\.8/);
  assert.throws(() => parseArgs(['--parallel', '9']), /1\.\.8/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
});

test('buildDumpFileName：命名规则 <db>_<YYYYMMDD>-<HHMMSS>.dump', () => {
  const name = buildDumpFileName('teacher_db_001', new Date('2026-08-30T02:03:04.000Z'));
  assert.equal(name, 'teacher_db_001_20260830-020304.dump');
  const shared = buildDumpFileName('teacher_platform', new Date('2026-08-30T02:00:00.000Z'));
  assert.equal(shared, 'teacher_platform_20260830-020000.dump');
});

test('hardenBackupPermissions：既有备份树收紧为目录 0700、文件 0600', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'ops-backup-legacy-'));
  const daily = resolve(root, 'daily');
  const monthly = resolve(root, 'monthly', 'archive');
  const dump = resolve(daily, 'legacy.dump');
  const manifest = resolve(daily, 'MANIFEST-legacy.json');
  const monthlyDump = resolve(monthly, 'legacy-monthly.dump');
  try {
    await mkdir(daily, { recursive: true, mode: 0o755 });
    await mkdir(monthly, { recursive: true, mode: 0o755 });
    await writeFile(dump, 'dump', { mode: 0o644 });
    await writeFile(manifest, '{}', { mode: 0o644 });
    await writeFile(monthlyDump, 'dump', { mode: 0o644 });
    await chmod(root, 0o755);
    await chmod(daily, 0o755);
    await chmod(resolve(root, 'monthly'), 0o755);
    await chmod(monthly, 0o755);
    await chmod(dump, 0o644);
    await chmod(manifest, 0o644);
    await chmod(monthlyDump, 0o644);

    await hardenBackupPermissions(root);

    for (const directory of [root, daily, resolve(root, 'monthly'), monthly]) {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    for (const file of [dump, manifest, monthlyDump]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enumerateBackupDatabases：包含共享库；未注册的库不出现', () => {
  const names = enumerateBackupDatabases(sourceUrl, sourceDatabaseName);
  assert.ok(names.includes('teacher_platform'));
  // 枚举源是 TeacherRegistry（当前为空 + 测试库未注册），裸建库不应被枚举
  assert.ok(!names.includes(createdDb));
});

test('dumpOneDatabase：pg_dump -Fc 产出 → sha256 + pg_restore -l 双校验 ok', async () => {
  const fileName = join(tempRoot, `${createdDb}.dump`);
  const entry = await dumpOneDatabase(sourceUrl, createdDb, 'run-test', fileName);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.name, createdDb);
  assert.ok(entry.bytes > 0);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(entry.pgRestoreListOk, true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(fileName)).mode & 0o777, 0o600, 'dump 必须仅当前用户可读写');
  }
});

test('dumpOneDatabase：不存在的库 → failed collect（不抛错）', async () => {
  const fileName = join(tempRoot, 'missing.dump');
  const entry = await dumpOneDatabase(sourceUrl, 'teacher_db_missing_000', 'run-test', fileName);
  assert.equal(entry.status, 'failed');
  assert.ok(entry.error);
  assert.equal(entry.pgRestoreListOk, false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(fileName)).mode & 0o777, 0o600, '失败 dump 残留也不得泄露');
  }
});

test('失败 collect：清单含失败项且 error 记录', async () => {
  const okEntry = await dumpOneDatabase(sourceUrl, createdDb, 'run-test', join(tempRoot, 'ok.dump'));
  const failEntry = await dumpOneDatabase(sourceUrl, 'teacher_db_missing_000', 'run-test', join(tempRoot, 'fail.dump'));
  assert.equal(okEntry.status, 'ok');
  assert.equal(failEntry.status, 'failed');
  assert.ok(failEntry.error.length > 0);
});

// ---- P8 t8 缺口1：MANIFEST media 段 ----

test('collectMediaManifest：存在媒体目录 → path+sha256+sizeBytes 递归清单', async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'ops-media-manifest-'));
  const assetDir = resolve(mediaRoot, 'media', 'teacher_a', 'asset_1');
  await mkdir(assetDir, { recursive: true });
  await mkdir(resolve(mediaRoot, 'media', 'teacher_b'), { recursive: true });
  const contentA = Buffer.from('media-file-a-bytes');
  await writeFile(resolve(assetDir, 'original'), contentA);
  await writeFile(resolve(mediaRoot, 'media', 'teacher_b', 'note.txt'), Buffer.from('media-file-b'));

  const result = await collectMediaManifest(mediaRoot);
  assert.equal(result.exists, true);
  assert.equal(result.files.length, 2);
  const paths = result.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['media/teacher_a/asset_1/original', 'media/teacher_b/note.txt']);
  const a = result.files.find((f) => f.path === 'media/teacher_a/asset_1/original');
  assert.equal(a.sha256, createHash('sha256').update(contentA).digest('hex'));
  assert.equal(a.sizeBytes, contentA.length);

  await rm(mediaRoot, { recursive: true, force: true });
});

test('collectMediaManifest：无媒体目录 → exists:false 空段不失败', async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'ops-media-nodir-'));
  const result = await collectMediaManifest(mediaRoot);
  assert.equal(result.exists, false);
  assert.deepEqual(result.files, []);
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
