import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  BUSINESS_TABLES,
  exportTable,
  lookupTeacherIdByDatabaseName,
  parseArgs,
  readTeacherAccount,
} from '../scripts/export-teacher-data.mjs';

const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
const maintenanceUrl = withDatabase(sourceUrl, 'postgres');

const TEACHER_ID = `teacher_export_test_${randomBytes(6).toString('hex')}`;
const TEACHER_EMAIL = `${TEACHER_ID}@example.com`;

let createdDb;
let tempRoot;

before(async () => {
  // 隔离教师库 + 造数（Student 2 行 + Payment 1 行 + Schedule 1 行 + MediaAsset 1 行）
  createdDb = `teacher_db_export_${randomBytes(6).toString('hex')}`;
  assertSafeTeacherDatabaseName(createdDb, sourceDatabaseName);
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(createdDb)}`);
  runMigrateDeploy(withDatabase(sourceUrl, createdDb));

  const seed = [
    `INSERT INTO "Student" ("id","teacherId","name","grade","currentStatus","createdAtTs","updatedAtTs")
       VALUES ('stu_1','${TEACHER_ID}','Export A','grade-1','active',now(),now()),
              ('stu_2','${TEACHER_ID}','Export B','grade-2','active',now(),now())`,
    `INSERT INTO "Payment" ("id","teacherId","studentId","amount","lessonCount","paidAtTs","createdAtTs","updatedAtTs")
       VALUES ('pay_1','${TEACHER_ID}','stu_1',100,10,'2026-01-01T00:00:00.000Z',now(),now())`,
    `INSERT INTO "Schedule" ("id","teacherId","title","type","scheduledStartTs","scheduledEndTs","createdAtTs","updatedAtTs")
       VALUES ('sch_1','${TEACHER_ID}','lesson-prep','lesson','2026-01-01T00:00:00.000Z','2026-01-01T01:00:00.000Z',now(),now())`,
    // P12 t4：媒体证据链元数据行（MediaAsset，教师库表）
    `INSERT INTO "MediaAsset" ("id","teacherId","mediaType","sha256","mimeType","sizeBytes","originalPath","createdAtTs")
       VALUES ('media_1','${TEACHER_ID}','image','${'a'.repeat(64)}','image/png',2048,'media/${TEACHER_ID}/media_1/original',now())`,
  ];
  for (const sql of seed) psqlQuery(sourceUrl, createdDb, sql);

  // 共享库注册该教师（databaseName 指向隔离库），验证 account 不含 passwordHash
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "TeacherRegistry" ("id","email","passwordHash","displayName","status","databaseName","createdAtTs","updatedAtTs")
     VALUES (${quoteLiteral(TEACHER_ID)}, ${quoteLiteral(TEACHER_EMAIL)}, 'scrypt:TEST-HASH-NOT-EXPORTED', 'Export Teacher', 'active',
             ${quoteLiteral(createdDb)}, now(), now())`,
  );

  // P12 t4：共享库教师维度表造数（ChannelIdentity——微信渠道绑定，共享库表；after 清理）
  psqlQuery(
    sourceUrl,
    'teacher_platform',
    `INSERT INTO "ChannelIdentity" ("id","teacherId","platform","externalUserId","updatedAtTs")
     VALUES ('chan_1',${quoteLiteral(TEACHER_ID)},'wechat','wxid_export_test',now())`,
  );

  tempRoot = await mkdtemp(join(tmpdir(), 'ops-export-'));
});

after(async () => {
  if (createdDb) {
    // 先删共享库从表（ChannelIdentity FK ON DELETE RESTRICT），再删 TeacherRegistry 主表
    psqlQuery(
      sourceUrl,
      'teacher_platform',
      `DELETE FROM "ChannelIdentity" WHERE "id" = 'chan_1' AND "teacherId" = ${quoteLiteral(TEACHER_ID)}`,
    );
    psqlQuery(
      sourceUrl,
      'teacher_platform',
      `DELETE FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(TEACHER_ID)}`,
    );
    psqlMaintenance(
      maintenanceUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${createdDb}' AND pid <> pg_backend_pid()`,
    );
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(createdDb)}`);
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test('parseArgs：三种身份互斥，缺一或多一均报错', () => {
  assert.equal(parseArgs(['--teacher-id', 't1', '--out', 'x']).teacherId, 't1');
  assert.equal(parseArgs(['--email', 'a@b.c']).email, 'a@b.c');
  assert.equal(parseArgs(['--database-name', 'teacher_db_001']).databaseName, 'teacher_db_001');
  assert.throws(() => parseArgs([]), /用法/);
  assert.throws(() => parseArgs(['--teacher-id', 't1', '--email', 'a@b.c']), /用法/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
});

test('BUSINESS_TABLES：45 个业务表固定清单（教师库 39 + 共享库 6，P12 t4 补漏 MediaAsset 等）', () => {
  assert.equal(BUSINESS_TABLES.length, 45);
  assert.ok(BUSINESS_TABLES.includes('Student'));
  assert.ok(BUSINESS_TABLES.includes('FeedbackEvidence'));
  // P12 t4：P8+ 新增表全部纳入
  assert.ok(BUSINESS_TABLES.includes('MediaAsset'));
  assert.ok(BUSINESS_TABLES.includes('ChannelIdentity'));
  assert.ok(BUSINESS_TABLES.includes('ChannelMessage'));
  assert.ok(BUSINESS_TABLES.includes('ChannelConversation'));
  assert.ok(BUSINESS_TABLES.includes('ProviderConfig'));
  assert.ok(BUSINESS_TABLES.includes('ProviderUsage'));
  assert.ok(BUSINESS_TABLES.includes('UserRequirement'));
  // 不含教师数据的表按既有语义排除
  assert.ok(!BUSINESS_TABLES.includes('AdminAccount'));
  assert.ok(!BUSINESS_TABLES.includes('AdminAuditLog'));
  assert.ok(!BUSINESS_TABLES.includes('TeacherRegistry'));
  assert.ok(!BUSINESS_TABLES.includes('SessionStore'));
});

test('readTeacherAccount：返回公开字段且 SQL 不含 passwordHash', () => {
  const account = readTeacherAccount(sourceUrl, { teacherId: TEACHER_ID });
  assert.ok(account);
  assert.equal(account.email, TEACHER_EMAIL);
  assert.equal(account.databaseName, createdDb);
  assert.equal(account.displayName, 'Export Teacher');
  assert.equal('passwordHash' in account, false); // 公开字段不含密码哈希

  // 不存在的教师 → null
  assert.equal(readTeacherAccount(sourceUrl, { teacherId: 'teacher_not_exist_000' }), null);
});

test('exportTable：按 teacherId 过滤导出 JSONL（含 JSONB 保真）', () => {
  const studentRows = exportTable(sourceUrl, createdDb, 'Student', TEACHER_ID);
  assert.equal(studentRows.length, 2);
  const parsed = JSON.parse(studentRows[0]);
  assert.equal(parsed.id, 'stu_1');
  assert.equal(parsed.teacherId, TEACHER_ID);
  assert.equal(parsed.name, 'Export A');

  const paymentRows = exportTable(sourceUrl, createdDb, 'Payment', TEACHER_ID);
  assert.equal(paymentRows.length, 1);
  assert.equal(JSON.parse(paymentRows[0]).amount, 100);

  // 其他教师 id 过滤 → 空
  assert.equal(exportTable(sourceUrl, createdDb, 'Student', 'teacher_other').length, 0);
});

test('exportTable：P12 t4 补漏——MediaAsset（教师库）+ ChannelIdentity（共享库）按 teacherId 过滤导出', () => {
  // MediaAsset：教师库表（隔离库），媒体证据链元数据行导出
  const mediaRows = exportTable(sourceUrl, createdDb, 'MediaAsset', TEACHER_ID);
  assert.equal(mediaRows.length, 1);
  const media = JSON.parse(mediaRows[0]);
  assert.equal(media.id, 'media_1');
  assert.equal(media.teacherId, TEACHER_ID);
  assert.equal(media.mediaType, 'image');
  assert.equal(media.originalPath, `media/${TEACHER_ID}/media_1/original`);
  assert.equal(media.sha256, 'a'.repeat(64));

  // ChannelIdentity：共享库表（teacher_platform），共享库教师维度数据导出
  const identityRows = exportTable(sourceUrl, 'teacher_platform', 'ChannelIdentity', TEACHER_ID);
  assert.equal(identityRows.length, 1);
  const identity = JSON.parse(identityRows[0]);
  assert.equal(identity.id, 'chan_1');
  assert.equal(identity.teacherId, TEACHER_ID);
  assert.equal(identity.platform, 'wechat');
  assert.equal(identity.externalUserId, 'wxid_export_test');

  // 其他教师 id 过滤 → 空（共享库表防跨教师泄露）
  assert.equal(exportTable(sourceUrl, 'teacher_platform', 'ChannelIdentity', 'teacher_other').length, 0);
});

test('lookupTeacherIdByDatabaseName：直连模式共享库表归属反查', () => {
  const ownerId = lookupTeacherIdByDatabaseName(sourceUrl, createdDb);
  assert.equal(ownerId, TEACHER_ID);
  // 未注册的库名 → null（不无过滤导出共享库表）
  assert.equal(lookupTeacherIdByDatabaseName(sourceUrl, 'teacher_db_unknown_000'), null);
});

test('end-to-end：--teacher-id 导出 → account.json 无 passwordHash + manifest 行数正确 + 媒体文件本体', async () => {
  const outDir = join(tempRoot, 'export-e2e');
  // P13 t2：造媒体源文件（MEDIA_STORAGE_ROOT 指向临时媒体根；MediaAsset 行 originalPath 指向该文件）
  const mediaRoot = join(tempRoot, 'media-root');
  const mediaKey = `media/${TEACHER_ID}/media_1/original`;
  await mkdir(join(mediaRoot, 'media', TEACHER_ID, 'media_1'), { recursive: true });
  const mediaContent = Buffer.from(`media-body-${TEACHER_ID}-\u56fe\u7247\u5185\u5bb9`);
  await writeFile(join(mediaRoot, ...mediaKey.split('/')), mediaContent);
  const prevMediaRoot = process.env.MEDIA_STORAGE_ROOT;
  process.env.MEDIA_STORAGE_ROOT = mediaRoot;
  // 直接调用主流程（spawn 方式在 Windows 管道编码上不稳定，用模块函数验证核心链路）
  const { main } = await import('../scripts/export-teacher-data.mjs');
  const originalArgv = process.argv;
  process.argv = ['node', 'export-teacher-data.mjs', '--teacher-id', TEACHER_ID, '--out', outDir];
  try {
    await main();
  } finally {
    if (prevMediaRoot === undefined) delete process.env.MEDIA_STORAGE_ROOT;
    else process.env.MEDIA_STORAGE_ROOT = prevMediaRoot;
    process.argv = originalArgv;
  }

  // account.json 不含 passwordHash
  const account = JSON.parse(await readFile(join(outDir, 'account.json'), 'utf8'));
  assert.equal(account.email, TEACHER_EMAIL);
  assert.equal('passwordHash' in account, false);

  // manifest：45 表 + 行数正确 + sha256 存在 + 来源库标注
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tables.length, 45);
  assert.equal(manifest.teacherId, TEACHER_ID);
  const studentEntry = manifest.tables.find((t) => t.table === 'Student');
  assert.equal(studentEntry.rows, 2);
  assert.equal(studentEntry.source, 'teacher_db');
  assert.match(studentEntry.sha256, /^[a-f0-9]{64}$/);
  const paymentEntry = manifest.tables.find((t) => t.table === 'Payment');
  assert.equal(paymentEntry.rows, 1);
  const scheduleEntry = manifest.tables.find((t) => t.table === 'Schedule');
  assert.equal(scheduleEntry.rows, 1);
  // P12 t4：MediaAsset（教师库）行数 + 来源；ChannelIdentity（共享库）行数 + 来源
  const mediaEntry = manifest.tables.find((t) => t.table === 'MediaAsset');
  assert.equal(mediaEntry.rows, 1);
  assert.equal(mediaEntry.source, 'teacher_db');
  const identityEntry = manifest.tables.find((t) => t.table === 'ChannelIdentity');
  assert.equal(identityEntry.rows, 1);
  assert.equal(identityEntry.source, 'shared_db');
  // 其余共享库表（无测试行）→ 空导出但 manifest 仍列示（确定性清单）
  const providerEntry = manifest.tables.find((t) => t.table === 'ProviderConfig');
  assert.equal(providerEntry.rows, 0);
  assert.equal(providerEntry.source, 'shared_db');

  // 文件落盘：student.jsonl 2 行、payment.jsonl 1 行、mediaasset.jsonl 1 行、channelidentity.jsonl 1 行、
  // 其余表空文件存在（文件名=模型名小写）
  const studentsJsonl = await readFile(join(outDir, 'tables', 'student.jsonl'), 'utf8');
  assert.equal(studentsJsonl.trim().split('\n').length, 2);
  const paymentsJsonl = await readFile(join(outDir, 'tables', 'payment.jsonl'), 'utf8');
  assert.equal(paymentsJsonl.trim().split('\n').length, 1);
  // P12 t4：内容正确——MediaAsset 元数据 + ChannelIdentity 共享库数据
  const mediaJsonl = await readFile(join(outDir, 'tables', 'mediaasset.jsonl'), 'utf8');
  assert.equal(mediaJsonl.trim().split('\n').length, 1);
  assert.equal(JSON.parse(mediaJsonl.trim()).mediaType, 'image');
  const identityJsonl = await readFile(join(outDir, 'tables', 'channelidentity.jsonl'), 'utf8');
  assert.equal(identityJsonl.trim().split('\n').length, 1);
  assert.equal(JSON.parse(identityJsonl.trim()).externalUserId, 'wxid_export_test');
  const files = await readdir(join(outDir, 'tables'));
  assert.equal(files.length, 45);

  // P13 t2：媒体文件本体——manifest.media 条目 {path,sha256,sizeBytes} + 副本逐字节一致 + 源未删
  assert.equal(manifest.media.length, 1);
  assert.deepEqual(manifest.media[0], {
    path: mediaKey,
    sha256: createHash('sha256').update(mediaContent).digest('hex'),
    sizeBytes: mediaContent.length,
  });
  const mediaCopy = await readFile(join(outDir, ...mediaKey.split('/')));
  assert.deepEqual(mediaCopy, mediaContent);
  assert.deepEqual(await readFile(join(mediaRoot, ...mediaKey.split('/'))), mediaContent); // 源只读未删
});

test('安全拒绝：--database-name 指向非 teacher_db_ 前缀 → SAFETY_BLOCK', async () => {
  const { main } = await import('../scripts/export-teacher-data.mjs');
  const originalArgv = process.argv;
  process.argv = ['node', 'export-teacher-data.mjs', '--database-name', 'evil_db', '--out', join(tempRoot, 'bad')];
  try {
    await assert.rejects(() => main(), /SAFETY_BLOCK/);
  } finally {
    process.argv = originalArgv;
  }
});

test('安全拒绝：不存在的教师 → 明确错误', async () => {
  const { main } = await import('../scripts/export-teacher-data.mjs');
  const originalArgv = process.argv;
  process.argv = ['node', 'export-teacher-data.mjs', '--teacher-id', 'teacher_not_exist_000', '--out', join(tempRoot, 'nope')];
  try {
    await assert.rejects(() => main(), /教师不存在/);
  } finally {
    process.argv = originalArgv;
  }
});

// ── P14 t5：--zip 单包（零依赖 store-only ZIP + CRC32 + UTF-8 文件名；含 media）──────────────

test('parseArgs：--zip 布尔开关', () => {
  assert.equal(parseArgs(['--teacher-id', 't1', '--zip']).zip, true);
  assert.equal(parseArgs(['--teacher-id', 't1']).zip, false);
  assert.equal(parseArgs(['--email', 'a@b.c', '--zip']).zip, true);
});

test('P14 t5 e2e：--zip 输出单包（manifest+account+tables+media）→ 解包结构/内容/CRC 与目录一致', { skip: process.platform !== 'win32' }, async () => {
  const outDir = join(tempRoot, 'export-e2e-zip');
  const mediaRoot = join(tempRoot, 'media-root-zip');
  const mediaKey = `media/${TEACHER_ID}/media_1/original`;
  await mkdir(join(mediaRoot, 'media', TEACHER_ID, 'media_1'), { recursive: true });
  const mediaContent = Buffer.from(`media-body-zip-${TEACHER_ID}-\u56fe\u7247\u5185\u5bb9`);
  await writeFile(join(mediaRoot, ...mediaKey.split('/')), mediaContent);
  const prevMediaRoot = process.env.MEDIA_STORAGE_ROOT;
  process.env.MEDIA_STORAGE_ROOT = mediaRoot;
  const { main } = await import('../scripts/export-teacher-data.mjs');
  const originalArgv = process.argv;
  process.argv = ['node', 'export-teacher-data.mjs', '--teacher-id', TEACHER_ID, '--out', outDir, '--zip'];
  try {
    await main();
  } finally {
    if (prevMediaRoot === undefined) delete process.env.MEDIA_STORAGE_ROOT;
    else process.env.MEDIA_STORAGE_ROOT = prevMediaRoot;
    process.argv = originalArgv;
  }

  // zip 产物存在（<out>.zip）且目录产物保留（zip 为交付包，目录供逐文件核对）
  const zipPath = `${outDir}.zip`;
  assert.ok(existsSync(zipPath), 'zip 产物应存在');
  assert.ok(existsSync(join(outDir, 'manifest.json')), '目录产物应保留（zip 为交付包）');

  // 解包（PowerShell 7.4+ Expand-Archive，真实解包器）→ 结构与内容校验
  const unzipDir = join(tempRoot, 'unzip-e2e-zip');
  const { execFileSync } = await import('node:child_process');
  execFileSync('pwsh', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${unzipDir}' -Force`,
  ], { stdio: 'pipe' });

  // 结构：manifest.json / account.json / tables/*.jsonl（45）/ media/*
  const manifest = JSON.parse(await readFile(join(unzipDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tables.length, 45);
  assert.equal(manifest.media.length, 1);
  assert.deepEqual(manifest.media[0], {
    path: mediaKey,
    sha256: createHash('sha256').update(mediaContent).digest('hex'),
    sizeBytes: mediaContent.length,
  });
  const account = JSON.parse(await readFile(join(unzipDir, 'account.json'), 'utf8'));
  assert.equal(account.email, TEACHER_EMAIL);
  assert.equal('passwordHash' in account, false);
  const unzipTables = await readdir(join(unzipDir, 'tables'));
  assert.equal(unzipTables.length, 45);
  const studentLines = await readFile(join(unzipDir, 'tables', 'student.jsonl'), 'utf8');
  assert.equal(studentLines.trim().split('\n').length, 2);

  // zip 内文件与目录产物 sha256 逐字节一致（zip 为 store-only，内容无损）
  const dirManifest = await readFile(join(outDir, 'manifest.json'), 'utf8');
  const zipManifest = await readFile(join(unzipDir, 'manifest.json'), 'utf8');
  assert.equal(
    createHash('sha256').update(zipManifest).digest('hex'),
    createHash('sha256').update(dirManifest).digest('hex'),
    'zip 内 manifest 与目录 manifest 一致',
  );
  // 媒体副本：zip 内 == 目录副本 == 源（只读未删）
  const zipMedia = await readFile(join(unzipDir, ...mediaKey.split('/')));
  assert.deepEqual(zipMedia, mediaContent);
  assert.deepEqual(await readFile(join(outDir, ...mediaKey.split('/'))), mediaContent);
  assert.deepEqual(await readFile(join(mediaRoot, ...mediaKey.split('/'))), mediaContent);
});
