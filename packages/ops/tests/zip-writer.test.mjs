import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertZipEntryName, crc32, createStoreOnlyZip } from '../lib/zip-writer.mjs';

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'ops-zip-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── CRC32 已知向量 ─────────────────────────────────────────────────────────

test('crc32：标准已知向量 "123456789" → 0xCBF43926', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

test('crc32：空输入 → 0；增量 seed 分段 == 一次整体（流式正确性）', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const data = Buffer.from('增量分段 CRC 校验 - incremental crc - 中文 content', 'utf8');
  const whole = crc32(data);
  let seed = 0;
  for (let i = 0; i < data.length; i += 7) {
    seed = crc32(data.subarray(i, i + 7), seed);
  }
  assert.equal(seed, whole);
});

test('crc32：string 入参按 UTF-8；不同字节序列区分（防误判）', () => {
  const a = crc32('hello');
  const b = crc32('world');
  assert.notEqual(a, b);
  assert.equal(crc32('中文'), crc32(Buffer.from('中文', 'utf8')));
});

// ── entry 名安全（zip slip 防护） ──────────────────────────────────────────

test('assertZipEntryName：拒绝绝对路径/盘符/反斜杠/.. 段/空名', () => {
  assertZipEntryName('manifest.json');
  assertZipEntryName('media/teacher_1/asset/original');
  assertZipEntryName('媒体/资源 001/原图.png'); // 中文+空格 key（UTF-8 名）合法
  for (const bad of ['', '../evil', 'a/../../evil', '/abs/evil', 'C:/evil', 'a\\b', '..']) {
    assert.throws(() => assertZipEntryName(bad), /SAFETY_BLOCK/, `应拒绝: ${bad}`);
  }
});

// ── ZIP 结构 ───────────────────────────────────────────────────────────────

test('createStoreOnlyZip：PK 魔数 + EOCD 尾 + 条目数与内容（固定时间可复现）', async () => {
  await withTemp(async (root) => {
    const zipPath = join(root, 'export.zip');
    const now = new Date('2026-08-23T00:00:00.000Z');
    const entries = [
      { name: 'manifest.json', data: '{"version":"1.0"}' },
      { name: 'tables/student.jsonl', data: Buffer.from('{"id":"s1"}\n') },
      { name: '媒体/资源 001/原图.png', data: randomBytes(64) },
    ];
    const result = await createStoreOnlyZip({
      outputPath: zipPath,
      now,
      entries,
    });
    assert.equal(result.entryCount, 3);
    assert.ok(result.sizeBytes > 0);
    const buf = await readFile(zipPath);
    assert.equal(buf.length, result.sizeBytes);
    // Local File Header 魔数 PK\x03\x04
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    // 每个条目 LFH 紧随数据（store-only：数据区 = size）
    // EOCD 魔数 PK\x05\x06 在文件尾
    assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
    // 中央目录条目数 = 3（EOCD 内 offset 10：sig4+disk2+cdDisk2 → entriesTotal）
    assert.equal(buf.readUInt16LE(buf.length - 22 + 10), 3);
    // 同输入同时间 → 字节级可复现（确定性测试友好：固定 now 的 DOS 时间戳）
    const zipPath2 = join(root, 'export2.zip');
    await createStoreOnlyZip({ outputPath: zipPath2, now, entries });
    const buf2 = await readFile(zipPath2);
    assert.deepEqual(buf, buf2); // 字节级一致（含媒体内容相同）
  });
});

test('createStoreOnlyZip：sourcePath 流式（大文件 O(1) 内存路径）与 data 等价', async () => {
  await withTemp(async (root) => {
    const sourceFile = join(root, 'big.bin');
    const content = randomBytes(256 * 1024); // 256KB 走流式路径
    const { writeFile } = await import('node:fs/promises');
    await writeFile(sourceFile, content);
    const zipPath = join(root, 'stream.zip');
    await createStoreOnlyZip({
      outputPath: zipPath,
      entries: [{ name: 'media/big.bin', sourcePath: sourceFile }],
    });
    const buf = await readFile(zipPath);
    // LFH(30) + name(13: 'media/big.bin') + data + CDH(46+13) + EOCD(22)
    assert.equal(buf.length, 30 + 13 + content.length + 46 + 13 + 22);
    // 数据区与源逐字节一致（store-only 不压缩）
    const dataStart = 30 + 13;
    assert.deepEqual(buf.subarray(dataStart, dataStart + content.length), content);
  });
});

// ── 真实解包器交叉验证（独立于自解析） ─────────────────────────────────────

test('createStoreOnlyZip：PowerShell Expand-Archive 解包 → 结构/内容/CRC 与源一致', { skip: process.platform !== 'win32' }, async () => {
  await withTemp(async (root) => {
    const zipPath = join(root, 'export.zip');
    const unzipDir = join(root, 'unzipped');
    const mediaContent = randomBytes(128);
    await createStoreOnlyZip({
      outputPath: zipPath,
      now: new Date('2026-08-23T00:00:00.000Z'),
      entries: [
        { name: 'manifest.json', data: '{"version":"1.0","media":[1]}' },
        { name: 'account.json', data: '{"id":"t1","email":"a@b.c"}' },
        { name: 'tables/student.jsonl', data: '{"id":"s1"}\n{"id":"s2"}\n' },
        { name: 'media/t1/a1/original', data: mediaContent },
        { name: '媒体/资源 001/原图.png', data: 'png-bytes' },
      ],
    });
    // Windows PowerShell 7.4+ Expand-Archive 解包（真实解包器，非自解析）
    execFileSync('pwsh', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${unzipDir}' -Force`,
    ], { stdio: 'pipe' });
    const manifest = await readFile(join(unzipDir, 'manifest.json'), 'utf8');
    assert.equal(JSON.parse(manifest).version, '1.0');
    const account = await readFile(join(unzipDir, 'account.json'), 'utf8');
    assert.equal(JSON.parse(account).email, 'a@b.c');
    const student = await readFile(join(unzipDir, 'tables', 'student.jsonl'), 'utf8');
    assert.equal(student, '{"id":"s1"}\n{"id":"s2"}\n');
    const media = await readFile(join(unzipDir, 'media', 't1', 'a1', 'original'));
    assert.deepEqual(media, mediaContent);
    // 中文+空格文件名解包正确（UTF-8 flag 生效，非 CP437 乱码）
    const chinese = await readFile(join(unzipDir, '媒体', '资源 001', '原图.png'), 'utf8');
    assert.equal(chinese, 'png-bytes');
  });
});
