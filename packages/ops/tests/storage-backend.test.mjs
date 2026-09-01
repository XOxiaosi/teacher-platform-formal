import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDirStorage, createS3Storage, createStorageBackendFromEnv } from '../lib/storage-backend.mjs';
import { startMockS3Server } from '../lib/testing/s3-mock-server.mjs';

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'ops-storage-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('put/get 往返：内容一致', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalDirStorage(root);
    const content = Buffer.from('PGDMP-binary-content');
    await storage.put('daily/teacher_platform_20260830-020000.dump', content);
    const got = await storage.get('daily/teacher_platform_20260830-020000.dump');
    assert.deepEqual(got, content);
    // 落盘真实文件存在
    const onDisk = await readFile(join(root, 'daily', 'teacher_platform_20260830-020000.dump'));
    assert.deepEqual(onDisk, content);
  });
});

test('put 自动创建子目录', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalDirStorage(root);
    await storage.put('monthly/x_20260101-020000.dump', Buffer.from('x'));
    const got = await storage.get('monthly/x_20260101-020000.dump');
    assert.equal(got.toString(), 'x');
  });
});

test('list 按前缀枚举文件（不含目录），缺失目录返回空数组', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalDirStorage(root);
    await storage.put('daily/a.dump', Buffer.from('a'));
    await storage.put('daily/b.dump', Buffer.from('b'));
    await storage.put('monthly/c.dump', Buffer.from('c'));
    const daily = await storage.list('daily/');
    assert.deepEqual(daily.sort(), ['daily/a.dump', 'daily/b.dump']);
    const empty = await storage.list('missing/');
    assert.deepEqual(empty, []);
  });
});

test('delete 删除文件', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalDirStorage(root);
    await storage.put('daily/a.dump', Buffer.from('a'));
    await storage.delete('daily/a.dump');
    assert.deepEqual(await storage.list('daily/'), []);
    await assert.rejects(() => storage.get('daily/a.dump'));
  });
});

test('路径穿越防护：拒绝 .. / 绝对路径 / 反斜杠 / 盘符', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalDirStorage(root);
    await assert.rejects(() => storage.put('../evil.dump', Buffer.from('x')), /SAFETY_BLOCK/);
    await assert.rejects(() => storage.put('daily/../../evil.dump', Buffer.from('x')), /SAFETY_BLOCK/);
    await assert.rejects(() => storage.put('/abs/evil.dump', Buffer.from('x')), /SAFETY_BLOCK/);
    await assert.rejects(() => storage.put('daily\\evil.dump', Buffer.from('x')), /SAFETY_BLOCK/);
    await assert.rejects(() => storage.put('C:/evil.dump', Buffer.from('x')), /SAFETY_BLOCK/);
    await assert.rejects(() => storage.put('', Buffer.from('x')), /SAFETY_BLOCK/);
    // get/delete 同防护
    await assert.rejects(() => storage.get('../secret'), /SAFETY_BLOCK/);
    await assert.rejects(() => storage.delete('../../secret'), /SAFETY_BLOCK/);
  });
});

// ── P11 t2：S3 兼容对象存储（mock 服务器校验 SigV4 签名 + 协议面）─────────────────────────────

const CREDS = { accessKeyId: 'test-access', secretAccessKey: 'test-secret-0123456789' };

async function withMockS3(fn) {
  const server = await startMockS3Server(CREDS);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

function createS3(server, extra = {}) {
  return createS3Storage({
    endpoint: server.url,
    bucket: server.bucket,
    ...CREDS,
    ...extra,
  });
}

test('s3: put/get 往返（SigV4 签名被 mock 校验）+ 对象入桶', async () => {
  await withMockS3(async (server) => {
    const storage = createS3(server);
    const content = Buffer.from('s3-binary-content-\u4e2d\u6587-\u00e9\u00e8');
    await storage.put('media/t1/a1/original', content);
    const got = await storage.get('media/t1/a1/original');
    assert.deepEqual(got, content);
    assert.deepEqual(server.bucketKeys(), ['media/t1/a1/original']);
  });
});

test('s3: put 自动创建层级 key；list 按前缀枚举；delete 后 get 抛 NoSuchKey', async () => {
  await withMockS3(async (server) => {
    const storage = createS3(server);
    await storage.put('media/t1/a1/original', Buffer.from('a'));
    await storage.put('media/t1/a2/original', Buffer.from('b'));
    await storage.put('backup/daily/x.dump', Buffer.from('c'));

    const mediaKeys = await storage.list('media/');
    assert.deepEqual(mediaKeys.sort(), ['media/t1/a1/original', 'media/t1/a2/original']);

    await storage.delete('media/t1/a1/original');
    assert.deepEqual((await storage.list('media/')).sort(), ['media/t1/a2/original']);
    await assert.rejects(
      () => storage.get('media/t1/a1/original'),
      (error) => error && error.code === 'NoSuchKey',
    );
  });
});

test('s3: 路径穿越防护（同 LocalDirStorage 纪律）', async () => {
  await withMockS3(async (server) => {
    const storage = createS3(server);
    for (const key of ['../evil', 'a/../../evil', '/abs/evil', 'a\\b', 'C:/evil', '']) {
      await assert.rejects(() => storage.put(key, Buffer.from('x')), /SAFETY_BLOCK/);
      await assert.rejects(() => storage.get(key), /SAFETY_BLOCK/);
      await assert.rejects(() => storage.delete(key), /SAFETY_BLOCK/);
    }
    assert.equal(server.objectCount(), 0);
  });
});

test('s3: mock 校验 SigV4——签名时间错误 → 403 SignatureDoesNotMatch（拒绝非自洽请求）', async () => {
  await withMockS3(async (server) => {
    // 注入固定过期时间 → 客户端签名与 mock 当前时间不一致 → mock 403
    const storage = createS3(server, { now: () => new Date('2020-01-01T00:00:00.000Z') });
    await assert.rejects(
      () => storage.put('media/x', Buffer.from('x')),
      (error) => error && error.code === 'SignatureDoesNotMatch',
    );
    assert.equal(server.objectCount(), 0);
  });
});

// ── P15 t1 防回归：mock 验签用请求 x-amz-date（服务器墙钟会跨秒误杀）────────────────────
// 背景：全量负载下 storage/media S3 mock 偶发失败——旧 mock 用服务器当前时间重算签名，
// 签名→验签跨秒（负载下偶发 >1s）即 403 SignatureDoesNotMatch（真实 S3 用请求自身时间戳
// 重算 + 15min 偏差容限，不会误杀）。修复后：容限内旧时间戳（2s 前）→ 接受；
// 超出容限（2020 年）→ 仍 403（上一用例锁定）。

test('s3: mock 时钟偏差容限内（2s 前签名）→ 接受（防服务器墙钟跨秒误杀）', async () => {
  await withMockS3(async (server) => {
    // 注入「2 秒前」签名时间——AWS 语义内合法（偏差容限 ±15min）；旧实现按服务器墙钟重算必 403
    const storage = createS3(server, { now: () => new Date(Date.now() - 2000) });
    await storage.put('media/clock-skew/original', Buffer.from('skew-tolerant'));
    assert.deepEqual(await storage.get('media/clock-skew/original'), Buffer.from('skew-tolerant'));
    assert.deepEqual(server.bucketKeys(), ['media/clock-skew/original']);
  });
});

// ── P14 t4 缺陷防回归：非 ASCII key（中文/空格）canonicalUri 双编码 -------------------------
// 背景：qa5 t3 真实 MinIO 验收暴露 s3-signer canonicalUri 对已百分号编码 pathname 二次编码
// （%E5.. → %25E5..）→ 中文/空格 key 真实 MinIO 403 SignatureDoesNotMatch；旧 mock 用同一
// 签名器验签「自洽」故掩盖。修复后 mock 改为独立规范验签（specCanonicalUri 先 decode 再单编码），
// 以下用例若 canonicalUri 回归双编码 → 客户端签名与 mock 独立重算不一致 → 403 → 测试红。

test('s3: 非 ASCII key（中文+空格）put/get/list/delete 全流程（防 canonicalUri 双编码回归）', async () => {
  await withMockS3(async (server) => {
    const storage = createS3(server);
    const keys = ['dir/子目录/文件 名.bin', '媒体/资源 001/原图.png', 'plain-ascii-key'];
    const bodies = keys.map((k, i) => Buffer.from(`body-${i}-中文内容-${k}`, 'utf8'));

    // put 全部（独立规范验签通过 → canonicalUri 单编码正确；双编码会在此 403）
    for (let i = 0; i < keys.length; i += 1) {
      await storage.put(keys[i], bodies[i]);
    }
    assert.equal(server.objectCount(), 3, `桶内对象数=${server.objectCount()}`);

    // get 回环（含中文/空格 key 原文一致）
    for (let i = 0; i < keys.length; i += 1) {
      const got = await storage.get(keys[i]);
      assert.deepEqual(got, bodies[i], `get 回环 ${keys[i]}`);
    }

    // list 前缀枚举（中文前缀 + 空格 key 均在列）
    const chineseList = await storage.list('dir/');
    assert.deepEqual(chineseList, ['dir/子目录/文件 名.bin'], `list(dir/)=${JSON.stringify(chineseList)}`);
    const mediaList = await storage.list('媒体/');
    assert.deepEqual(mediaList, ['媒体/资源 001/原图.png'], `list(媒体/)=${JSON.stringify(mediaList)}`);

    // delete 后 get → NoSuchKey（中文+空格 key 删除路径同样经规范签名）
    await storage.delete(keys[0]);
    assert.deepEqual(await storage.list('dir/'), [], 'delete 后 dir/ 为空');
    await assert.rejects(
      () => storage.get(keys[0]),
      (error) => error && error.code === 'NoSuchKey',
    );
  });
});

test('s3: 配置缺失 → SAFETY_BLOCK 快速失败（不静默回退本地）', () => {
  assert.throws(() => createS3Storage({ endpoint: 'not-a-url', bucket: 'b', ...CREDS }), /SAFETY_BLOCK/);
  assert.throws(() => createS3Storage({ endpoint: 'http://127.0.0.1:9', bucket: '', ...CREDS }), /SAFETY_BLOCK/);
  assert.throws(() => createS3Storage({ endpoint: 'http://127.0.0.1:9', bucket: 'b' }), /SAFETY_BLOCK/);
});

// ── P11 t2：env 存储选择（STORAGE_BACKEND=local|s3，缺省 local 零破坏）──────────────────────

test('createStorageBackendFromEnv：缺省 → local（零破坏基线）', async () => {
  const backend = createStorageBackendFromEnv({});
  assert.equal(backend.kind, 'local');
});

test('createStorageBackendFromEnv：STORAGE_BACKEND=local → LocalDirStorage 落盘', async () => {
  await withTempRoot(async (root) => {
    const backend = createStorageBackendFromEnv({ STORAGE_LOCAL_ROOT: root });
    assert.equal(backend.kind, 'local');
    await backend.put('daily/x.dump', Buffer.from('local-x'));
    assert.deepEqual(await backend.get('daily/x.dump'), Buffer.from('local-x'));
    assert.deepEqual(await readFile(join(root, 'daily', 'x.dump')), Buffer.from('local-x'));
  });
});

test('createStorageBackendFromEnv：STORAGE_BACKEND=s3 → S3 实现（对象入桶）', async () => {
  await withMockS3(async (server) => {
    const backend = createStorageBackendFromEnv({
      STORAGE_BACKEND: 's3',
      STORAGE_S3_ENDPOINT: server.url,
      STORAGE_S3_BUCKET: server.bucket,
      STORAGE_S3_ACCESS_KEY_ID: CREDS.accessKeyId,
      STORAGE_S3_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
    });
    assert.equal(backend.kind, 's3');
    assert.equal(backend.bucket, server.bucket);
    await backend.put('media/t9/a9/original', Buffer.from('media-object'));
    assert.deepEqual(server.bucketKeys(), ['media/t9/a9/original']);
    assert.deepEqual(await backend.get('media/t9/a9/original'), Buffer.from('media-object'));
  });
});

test('createStorageBackendFromEnv：s3 缺凭据 → SAFETY_BLOCK（不静默回退本地）', () => {
  assert.throws(
    () => createStorageBackendFromEnv({ STORAGE_BACKEND: 's3' }),
    /SAFETY_BLOCK/,
  );
  assert.throws(
    () => createStorageBackendFromEnv({
      STORAGE_BACKEND: 's3',
      STORAGE_S3_ENDPOINT: 'http://127.0.0.1:9000',
      STORAGE_S3_BUCKET: 'b',
    }),
    /SAFETY_BLOCK/,
  );
});

test('createStorageBackendFromEnv：未知值 → 按 local（宽容降级不崩服）；大小写/空白归一', () => {
  assert.equal(createStorageBackendFromEnv({ STORAGE_BACKEND: 'garbage' }).kind, 'local');
  // ' S3 ' 归一为 s3 → 缺凭据 → SAFETY_BLOCK 快速失败（不静默回退）
  assert.throws(() => createStorageBackendFromEnv({ STORAGE_BACKEND: ' S3 ' }), /SAFETY_BLOCK/);
});
