import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDirStorage, createS3Storage } from '../lib/storage-backend.mjs';
import { startMockS3Server } from '../lib/testing/s3-mock-server.mjs';
import { collectExportZipEntries, exportMediaKeysFromRows, exportTeacherMedia, prepareExportDirectory, createTeacherExportStorage } from '../lib/teacher-export-media.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

test('media rows: deduplicate owned paths, fail closed on damaged rows and cross-tenant paths', () => {
  const row = path => JSON.stringify({ teacherId: 't1', originalPath: path });
  assert.deepEqual(exportMediaKeysFromRows([row('media/t1/a2/original'), row('media/t1/a1/original'), row('media/t1/a1/original')], 't1'), ['media/t1/a1/original', 'media/t1/a2/original']);
  assert.deepEqual(exportMediaKeysFromRows([], 't1'), []);
  for (const line of ['not-json', '{}', row('media/t2/a1/original'), row('media/t1/../original'), row('media/t1/a1/../../evil')]) {
    assert.throws(() => exportMediaKeysFromRows([line], 't1'), /SAFETY_BLOCK/);
  }
});

test('P13 t2 单测：exportTeacherMedia（local）——文件副本 + manifest.media {path,sha256,sizeBytes} 与源一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-export-media-'));
  try {
    const storageRoot = join(root, 'storage');
    const outDir = join(root, 'export');
    const keyA = 'media/t1/a1/original';
    const keyB = 'media/t1/a2/original';
    const contentA = Buffer.from('media-body-a-\u4e2d\u6587-\u00e9');
    const contentB = Buffer.from('media-body-b-\u4e2d\u6587-\u00e9');
    await mkdir(join(storageRoot, 'media', 't1', 'a1'), { recursive: true });
    await mkdir(join(storageRoot, 'media', 't1', 'a2'), { recursive: true });
    await writeFile(join(storageRoot, ...keyA.split('/')), contentA);
    await writeFile(join(storageRoot, ...keyB.split('/')), contentB);

    const storage = createTeacherExportStorage({}, storageRoot, 't1');
    const entries = await exportTeacherMedia(storage, [keyB, keyA], outDir, 't1'); // 无序输入按序导出

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.path), [keyB, keyA]);
    assert.deepEqual(entries[0], {
      path: keyB,
      sha256: createHash('sha256').update(contentB).digest('hex'),
      sizeBytes: contentB.length,
    });
    assert.deepEqual(entries[1], {
      path: keyA,
      sha256: createHash('sha256').update(contentA).digest('hex'),
      sizeBytes: contentA.length,
    });
    // 副本与源逐字节一致；源目录未删（只读导出）
    assert.deepEqual(await readFile(join(outDir, ...keyA.split('/'))), contentA);
    assert.deepEqual(await readFile(join(outDir, ...keyB.split('/'))), contentB);
    assert.ok(existsSync(join(storageRoot, ...keyA.split('/'))));
    assert.ok(existsSync(join(storageRoot, ...keyB.split('/'))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P13 t2 单测：exportTeacherMedia（local）——缺失文件记 {path,status:missing} 不阻断，其余正常导出', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-export-media-missing-'));
  try {
    const storageRoot = join(root, 'storage');
    const outDir = join(root, 'export');
    const existing = 'media/t1/a1/original';
    const missing = 'media/t1/a9/original';
    await mkdir(join(storageRoot, 'media', 't1', 'a1'), { recursive: true });
    await writeFile(join(storageRoot, ...existing.split('/')), Buffer.from('exists'));
    const storage = createTeacherExportStorage({}, storageRoot, 't1');
    const entries = await exportTeacherMedia(storage, [existing, missing], outDir, 't1');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].status, undefined);
    assert.deepEqual(entries[1], { path: missing, status: 'missing' });
    assert.ok(existsSync(join(outDir, ...existing.split('/'))));
    assert.equal(existsSync(join(outDir, ...missing.split('/'))), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P13 t2 单测：exportTeacherMedia——空 key 清单 → []（media 段空，不建目录）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-export-media-empty-'));
  try {
    const outDir = join(root, 'export');
    const entries = await exportTeacherMedia(createLocalDirStorage(join(root, 'storage')), [], outDir, 't1');
    assert.deepEqual(entries, []);
    assert.equal(existsSync(join(outDir, 'media')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P13 t2 单测：exportTeacherMedia（s3 mock）——桶对象读取 + 副本 sha256 一致 + 桶对象未删', async () => {
  const CREDS = { accessKeyId: 'test-access', secretAccessKey: 'test-secret-0123456789' };
  const server = await startMockS3Server(CREDS);
  const root = await mkdtemp(join(tmpdir(), 'ops-export-s3-'));
  try {
    const storage = createS3Storage({ endpoint: server.url, bucket: server.bucket, ...CREDS });
    const keyA = 'media/t2/a1/original';
    const keyB = 'media/t2/a2/original';
    const contentA = Buffer.from('s3-body-a');
    const contentB = Buffer.from('s3-body-b');
    await storage.put(keyA, contentA);
    await storage.put(keyB, contentB);
    const outDir = join(root, 'export');
    const entries = await exportTeacherMedia(storage, [keyA, keyB], outDir, 't2');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      path: keyA,
      sha256: createHash('sha256').update(contentA).digest('hex'),
      sizeBytes: contentA.length,
    });
    assert.deepEqual(entries[1], {
      path: keyB,
      sha256: createHash('sha256').update(contentB).digest('hex'),
      sizeBytes: contentB.length,
    });
    // 副本落地 + 桶内对象仍在（只读不删）
    assert.deepEqual(await readFile(join(outDir, ...keyA.split('/'))), contentA);
    assert.deepEqual(await readFile(join(outDir, ...keyB.split('/'))), contentB);
    assert.deepEqual((await storage.list('media/')).sort(), [keyA, keyB]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('P13 t2 单测：exportTeacherMedia——穿越 key → storage.get SAFETY_BLOCK（不写出 outDir 外）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-export-media-safe-'));
  try {
    const storage = createLocalDirStorage(join(root, 'storage'));
    await assert.rejects(
      () => exportTeacherMedia(storage, ['../evil'], join(root, 'export'), 't1'),
      /SAFETY_BLOCK/,
    );
    await assert.rejects(
      () => exportTeacherMedia(storage, ['a/../../evil'], join(root, 'export'), 't1'),
      /SAFETY_BLOCK/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collectExportZipEntries：递归收集目录文件 → zip 相对名（含中文/空格）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-zip-entries-'));
  try {
    const mediaDir = join(root, 'media', 't1', '资源 001');
    await mkdir(mediaDir, { recursive: true });
    await mkdir(join(root, 'tables'), { recursive: true });
    await writeFile(join(root, 'account.json'), '{}');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ teacherId: 't1', accountSha256: hash('{}'), tables: [{ file: 'tables/student.jsonl', sha256: hash('x') }], media: [{ path: 'media/t1/资源 001/原图.png', sha256: hash('png') }] }));
    await writeFile(join(root, 'tables', 'student.jsonl'), 'x');
    await writeFile(join(mediaDir, '原图.png'), 'png');
    const entries = await collectExportZipEntries(root);
    assert.deepEqual(entries.map((e) => e.name), [
      'account.json',
      'manifest.json',
      'media/t1/资源 001/原图.png',
      'tables/student.jsonl',
    ]);
    for (const e of entries) assert.equal(e.sourcePath.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('invalid tenant media keys are rejected before storage.get, with no partial copy', async () => {
  let reads = 0;
  const storage = { get() { reads++; return Buffer.from('private'); } };
  await assert.rejects(() => exportTeacherMedia(storage, ['media/t1/a/original', 'media/t2/b/original'], '/unused', 't1'), /SAFETY_BLOCK/);
  assert.equal(reads, 0);
});

test('output preparation preserves and rejects nonempty directories, symlinks and existing zip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-export-output-'));
  try {
    const out = join(root, 'out');
    await prepareExportDirectory(out, false);
    await writeFile(join(out, 'old-secret'), 'preserve');
    await assert.rejects(() => prepareExportDirectory(out, false), /SAFETY_BLOCK/);
    assert.equal(await readFile(join(out, 'old-secret'), 'utf8'), 'preserve');
    await symlink(out, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => prepareExportDirectory(join(root, 'link'), false), /SAFETY_BLOCK/);
    const empty = join(root, 'fresh');
    await writeFile(`${empty}.zip`, 'preserve-zip');
    await assert.rejects(() => prepareExportDirectory(empty, true), /SAFETY_BLOCK/);
    assert.equal(await readFile(`${empty}.zip`, 'utf8'), 'preserve-zip');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manifest packaging rejects stale files, changed bytes, missing entries, foreign media and symlinks', async () => {
  for (const mode of ['stale', 'digest', 'missing', 'foreign', 'symlink', 'manifest', 'unknown']) {
    const root = await mkdtemp(join(tmpdir(), 'ops-export-manifest-'));
    try {
      const manifest = { teacherId: 't1', accountSha256: hash('{}'), tables: [], media: [] };
      await writeFile(join(root, 'account.json'), '{}');
      await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
      if (mode === 'stale') await writeFile(join(root, 'old-secret'), 'preserve');
      if (mode === 'digest') await writeFile(join(root, 'account.json'), 'changed');
      if (mode === 'missing') await rm(join(root, 'account.json'));
      if (mode === 'foreign') {
        manifest.media.push({ path: 'media/t2/asset/original', status: 'missing' });
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
      }
      if (mode === 'symlink') await symlink(root, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      if (mode === 'unknown') {
        manifest.tables.push({ file: 'tables/sessionstore.jsonl', sha256: hash('secret') });
        await mkdir(join(root, 'tables'));
        await writeFile(join(root, 'tables/sessionstore.jsonl'), 'secret');
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
      }
      if (mode === 'manifest') await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, extra: true }));
      await assert.rejects(() => collectExportZipEntries(root, manifest), /SAFETY_BLOCK/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('exclusive ZIP creation cannot overwrite an existing archive', async () => {
  const { createStoreOnlyZip } = await import('../lib/zip-writer.mjs');
  const root = await mkdtemp(join(tmpdir(), 'ops-export-exclusive-'));
  try {
    const path = join(root, 'export.zip');
    await createStoreOnlyZip({ outputPath: path, entries: [{ name: 'manifest.json', data: '{}' }], exclusive: true });
    const original = await readFile(path);
    await assert.rejects(() => createStoreOnlyZip({ outputPath: path, entries: [], exclusive: true }), /EEXIST/);
    assert.deepEqual(await readFile(path), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const linkType of ['file', 'directory']) {
  test(`local media source ${linkType} symlink cannot redirect teacher A to teacher B`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ops-export-source-link-'));
    try {
      const source = join(root, 'source');
      const a = join(source, 'media', 'A', 'asset');
      const b = join(source, 'media', 'B', 'asset');
      await mkdir(b, { recursive: true });
      await writeFile(join(b, 'original'), 'B_PRIVATE_SYNTHETIC');
      await mkdir(linkType === 'file' ? a : join(source, 'media', 'A'), { recursive: true });
      try {
        await symlink(linkType === 'file' ? join(b, 'original') : b,
          linkType === 'file' ? join(a, 'original') : a,
          linkType === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (process.platform === 'win32' && linkType === 'file' && error.code === 'EPERM') {
          t.skip('Windows file symlink requires Developer Mode or symlink privilege; directory junction is tested separately');
          return;
        }
        throw error;
      }
      const out = join(root, 'out');
      const storage = createTeacherExportStorage({ STORAGE_LOCAL_ROOT: source }, join(root, 'unused'), 'A');
      await assert.rejects(() => exportTeacherMedia(storage, ['media/A/asset/original'], out, 'A'), /SAFETY_BLOCK/);
      assert.equal(existsSync(out), false);
      assert.equal(await readFile(join(b, 'original'), 'utf8'), 'B_PRIVATE_SYNTHETIC');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
