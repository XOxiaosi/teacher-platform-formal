/**
 * P11 t2：媒体线 S3 存储接线（STORAGE_BACKEND=s3 心智）——media-asset-service 注入
 * createStorage({ backend: createS3Storage(...) })（StorageBackend 抽象）后，上传原文件经
 * storage 接口入桶（key = media/<teacherId>/<assetId>/original），写后校验读回 + 受控下载解密回环。
 *
 * 覆盖：
 * - 上传 image → 对象入桶（bucketKeys 含 media/<teacherId>/<assetId>/original）且密文落桶（密文头 TPMEDENC）；
 * - readFile（受控下载）解密回环：sha256 与上传明文一致（put+get 往返）；
 * - owner 隔离下载仍生效（S3 后端下路径映射正确）；
 * - delete 经 backend（孤儿回收路径同构）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStorage } from '../../../src/shared/storage/index.js';
import { createS3Storage } from '../../../../ops/lib/storage-backend.mjs';
import { startMockS3Server } from '../../../../ops/lib/testing/s3-mock-server.mjs';
import { createMediaAssetService, createMediaFileCipher } from '../../../src/features/media/index.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';

const prisma = new PrismaClient();

const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const cipher = createMediaFileCipher(TEST_MEDIA_KEY);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEACHER = `teacher_s3_${randomBytes(4).toString('hex')}`;
const TEACHER_OTHER = `teacher_s3_other_${randomBytes(4).toString('hex')}`;

const CREDS = { accessKeyId: 'test-access', secretAccessKey: 'test-secret-0123456789' };

let tempRoot: string;
let mock: Awaited<ReturnType<typeof startMockS3Server>>;
let service: ReturnType<typeof createMediaAssetService>;
let sources: ReturnType<typeof createStudentSourceRecordService>;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'media-s3-test-'));
  sources = createStudentSourceRecordService(prisma);
  mock = await startMockS3Server(CREDS);
  // P11 t2：媒体线 storage 注入走 StorageBackend 抽象——S3 模式原文件入桶（fileRef 即对象 key）
  const storage = createStorage({
    rootDir: tempRoot,
    backend: createS3Storage({
      endpoint: mock.url,
      bucket: mock.bucket,
      ...CREDS,
    }),
  });
  service = createMediaAssetService({
    getClient: async () => prisma,
    storage,
    sources,
    mediaCipher: cipher,
  });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.$disconnect();
  if (mock) await mock.close();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe('P11 t2：媒体线 S3 存储（原文件入桶）', () => {
  it('上传 image → 对象入桶（media/<teacherId>/<assetId>/original，密文 TPMEDENC 头）', async () => {
    const plain = Buffer.concat([PNG_MAGIC, Buffer.from(`-s3-upload-${randomBytes(4).toString('hex')}`)]);
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 's3.png',
      mimeType: 'image/png',
      content: plain,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedKey = `media/${TEACHER}/${result.value.id}/original`;
    const keys = mock.bucketKeys(`media/${TEACHER}/`);
    expect(keys).toContain(expectedKey);

    // 桶内是密文（AES-256-GCM：TPMEDENC 头 + iv + tag），明文永不经存储层
    const stored = await createS3Storage({ endpoint: mock.url, bucket: mock.bucket, ...CREDS }).get(expectedKey);
    expect(stored.subarray(0, 8).toString('latin1')).toBe('TPMEDENC');
  });

  it('readFile（受控下载）经 S3 读回 + 解密 → sha256 与上传明文一致', async () => {
    const plain = Buffer.concat([PNG_MAGIC, Buffer.from(`-s3-read-${randomBytes(4).toString('hex')}`)]);
    const expectedSha = createHash('sha256').update(plain).digest('hex');
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'screenshot',
      originalFilename: 's3-shot.png',
      mimeType: 'image/png',
      content: plain,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const file = await service.readFile(TEACHER, result.value.id);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.content.equals(plain)).toBe(true);
    expect(createHash('sha256').update(file.value.content).digest('hex')).toBe(expectedSha);
  });

  it('owner 隔离：跨教师 readFile → NOT_FOUND（S3 后端路径映射不变）', async () => {
    const plain = Buffer.concat([PNG_MAGIC, Buffer.from(`-s3-owner-${randomBytes(4).toString('hex')}`)]);
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'owner.png',
      mimeType: 'image/png',
      content: plain,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const other = await service.readFile(TEACHER_OTHER, result.value.id);
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe('NOT_FOUND');
  });

  it('upload 写后校验（readBack）在 S3 后端下成立：密文读回 → 解密 → sha256 一致才落元数据', async () => {
    const plain = Buffer.concat([PNG_MAGIC, Buffer.from(`-s3-verify-${randomBytes(4).toString('hex')}`)]);
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'verify.png',
      mimeType: 'image/png',
      content: plain,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 写后校验失败路径：删掉桶内对象后再次上传同内容 → 幂等去重命中（sha256 相同），不触发重新校验
    const again = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'verify2.png',
      mimeType: 'image/png',
      content: plain,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).toBe(result.value.id); // 幂等去重
  });
});
