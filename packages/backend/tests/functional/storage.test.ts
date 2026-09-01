import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppStorage, createStorage, type StorageBackend } from '../../src/shared/storage/index.js';
import { startMockS3Server } from '../../../ops/lib/testing/s3-mock-server.mjs';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'teacher-platform-storage-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('storage', () => {
  it('save 保存 Buffer 并返回 fileRef', async () => {
    const storage = createStorage({ rootDir });
    const result = await storage.save({
      filename: 'voice.m4a',
      content: Buffer.from('audio-data'),
      directory: 'audio',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileRef).toContain('audio/');
    expect(result.value.fileRef).toContain('voice.m4a');
  });

  it('read 读取已保存文件', async () => {
    const storage = createStorage({ rootDir });
    const saved = await storage.save({ filename: 'note.txt', content: 'hello', directory: 'notes' });
    if (!saved.ok) return;

    const result = await storage.read({ fileRef: saved.value.fileRef });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toString()).toBe('hello');
  });

  it('delete 删除已保存文件', async () => {
    const storage = createStorage({ rootDir });
    const saved = await storage.save({ filename: 'note.txt', content: 'hello' });
    if (!saved.ok) return;

    const deleted = await storage.delete({ fileRef: saved.value.fileRef });
    expect(deleted.ok).toBe(true);

    const read = await storage.read({ fileRef: saved.value.fileRef });
    expect(read.ok).toBe(false);
  });

  it('read 不存在文件返回 NOT_FOUND', async () => {
    const storage = createStorage({ rootDir });
    const result = await storage.read({ fileRef: 'missing.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('阻止路径穿越', async () => {
    const storage = createStorage({ rootDir });
    const result = await storage.save({ filename: '../escape.txt', content: 'x' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

/**
 * P11 t2：StorageBackend 抽象委托（createStorage backend 注入）——save/read/delete 经
 * backend.put/get/delete，fileRef 即对象 key；错误归一（NoSuchKey → NOT_FOUND，SAFETY_BLOCK → VALIDATION_ERROR）。
 */
describe('storage backend 委托（StorageBackend 抽象）', () => {
  /** 内存 fake backend（S3 语义：NoSuchKey 缺失、kind=s3+bucket 供 absolutePath 合成）。 */
  function fakeS3Backend(): { backend: StorageBackend; objects: Map<string, Buffer> } {
    const objects = new Map<string, Buffer>();
    const backend: StorageBackend = {
      kind: 's3',
      bucket: 'test-bucket',
      async put(key, content) {
        objects.set(key, Buffer.from(content));
      },
      async get(key) {
        const value = objects.get(key);
        if (value === undefined) {
          const error = new Error(`S3 对象不存在: ${key}`) as Error & { code: string };
          error.code = 'NoSuchKey';
          throw error;
        }
        return value;
      },
      async list(prefix) {
        return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      },
      async delete(key) {
        if (!objects.delete(key)) {
          const error = new Error(`S3 对象不存在: ${key}`) as Error & { code: string };
          error.code = 'NoSuchKey';
          throw error;
        }
      },
    };
    return { backend, objects };
  }

  it('save 委托 backend.put（exactRef 即对象 key）+ absolutePath=s3://bucket/key', async () => {
    const { backend, objects } = fakeS3Backend();
    const storage = createStorage({ rootDir, backend });
    const saved = await storage.save({
      exactRef: 'media/t1/a1/original',
      filename: 'original',
      content: Buffer.from('media-bytes'),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.fileRef).toBe('media/t1/a1/original');
    expect(saved.value.absolutePath).toBe('s3://test-bucket/media/t1/a1/original');
    expect(objects.get('media/t1/a1/original')?.equals(Buffer.from('media-bytes'))).toBe(true);
  });

  it('save 委托 backend.put（directory+filename 组合 key）', async () => {
    const { backend, objects } = fakeS3Backend();
    const storage = createStorage({ rootDir, backend });
    const saved = await storage.save({
      filename: 'note.txt',
      content: 'hello',
      directory: 'notes',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.fileRef).toContain('notes/');
    expect(objects.has(saved.value.fileRef)).toBe(true);
  });

  it('read/delete 经 backend 往返；缺对象 → NOT_FOUND（NoSuchKey 归一）', async () => {
    const { backend } = fakeS3Backend();
    const storage = createStorage({ rootDir, backend });
    const saved = await storage.save({ exactRef: 'media/x/original', filename: 'original', content: 'abc' });
    if (!saved.ok) return;

    const read = await storage.read({ fileRef: 'media/x/original' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.toString()).toBe('abc');

    const deleted = await storage.delete({ fileRef: 'media/x/original' });
    expect(deleted.ok).toBe(true);

    const missing = await storage.read({ fileRef: 'media/x/original' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');
  });

  it('backend SAFETY_BLOCK → VALIDATION_ERROR（路径防护同纪律）', async () => {
    const { backend } = fakeS3Backend();
    const originalPut = backend.put.bind(backend);
    backend.put = async (key, content) => {
      if (key.includes('\\')) {
        throw new Error('SAFETY_BLOCK: storage key must use forward slashes');
      }
      return originalPut(key, content);
    };
    const storage = createStorage({ rootDir, backend });
    // exactRef 含反斜杠：buildFileRef（posix 归一）不拦截，由 backend 层 SAFETY_BLOCK → VALIDATION_ERROR
    const result = await storage.save({ exactRef: 'media\\evil', filename: 'x', content: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('forward slashes');
  });

  it('backend 非已知错误 → INTERNAL_ERROR', async () => {
    const backend: StorageBackend = {
      kind: 's3',
      bucket: 'b',
      async put() {
        throw new Error('network down');
      },
      async get() {
        throw new Error('network down');
      },
      async list() {
        return [];
      },
      async delete() {
        throw new Error('network down');
      },
    };
    const storage = createStorage({ rootDir, backend });
    const saved = await storage.save({ exactRef: 'media/x', filename: 'x', content: 'x' });
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.code).toBe('INTERNAL_ERROR');
  });
});

/**
 * P11 t2：createAppStorage env 选择（STORAGE_BACKEND=local 缺省零破坏 | s3 对象入桶）。
 */
describe('createAppStorage（env 存储选择）', () => {
  it('缺省 → local：save 落盘真实文件（零破坏基线）', async () => {
    const storage = createAppStorage({}, rootDir);
    const saved = await storage.save({ exactRef: 'media/t1/a1/original', filename: 'original', content: 'local-bytes' });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const onDisk = await readFile(join(rootDir, 'media', 't1', 'a1', 'original'));
    expect(onDisk.toString()).toBe('local-bytes');
  });

  it('STORAGE_BACKEND=s3 → save 对象入桶（STORAGE_S3_* env）', async () => {
    const mock = await startMockS3Server({ accessKeyId: 'test-access', secretAccessKey: 'test-secret-0123456789' });
    try {
      const storage = createAppStorage({
        STORAGE_BACKEND: 's3',
        STORAGE_S3_ENDPOINT: mock.url,
        STORAGE_S3_BUCKET: mock.bucket,
        STORAGE_S3_ACCESS_KEY_ID: 'test-access',
        STORAGE_S3_SECRET_ACCESS_KEY: 'test-secret-0123456789',
      }, rootDir);
      const saved = await storage.save({ exactRef: 'media/t2/a2/original', filename: 'original', content: 'bucket-bytes' });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.absolutePath).toBe(`s3://${mock.bucket}/media/t2/a2/original`);
      expect(mock.bucketKeys()).toEqual(['media/t2/a2/original']);
      const read = await storage.read({ fileRef: 'media/t2/a2/original' });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.toString()).toBe('bucket-bytes');
    } finally {
      await mock.close();
    }
  });

  it('STORAGE_BACKEND=s3 缺凭据 → SAFETY_BLOCK 装配期快速失败（不静默回退本地）', () => {
    expect(() => createAppStorage({ STORAGE_BACKEND: 's3' }, rootDir)).toThrow(/SAFETY_BLOCK/);
  });
});
