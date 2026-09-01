import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createStorage } from '../../../src/shared/storage/index.js';
import { createMediaAssetService } from '../../../src/features/media/index.js';
import { createMediaFileCipher, isMediaEncryptedFile } from '../../../src/features/media/index.js';
import { createMediaRouter } from '../../../src/app/routes/media.routes.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import type { AuthService } from '../../../src/features/auth/index.js';

const prisma = new PrismaClient();

// 测试密钥（32 字节，仅测试用；生产 MEDIA_ENCRYPTION_KEY 独立 env 注入，禁硬编码）
const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngContent(seed = 'png-data'): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(`image-${seed}-${randomBytes(4).toString('hex')}`)]);
}
const JPEG_CONTENT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-data')]);
const WEBP_CONTENT = Buffer.concat([
  Buffer.from('RIFFxxxxWEBP', 'latin1'),
  Buffer.from('webp-data'),
]);
const TEXT_CONTENT = Buffer.from('not an image at all');

const TEACHER_A = `teacher_media_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_media_b_${randomBytes(4).toString('hex')}`;
const STUDENT_A = `student_media_a_${randomBytes(4).toString('hex')}`;

let tempRoot: string;
let service: ReturnType<typeof createMediaAssetService>;
let sources: ReturnType<typeof createStudentSourceRecordService>;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'media-test-'));
  const storage = createStorage({ rootDir: tempRoot });
  sources = createStudentSourceRecordService(prisma);
  service = createMediaAssetService({
    getClient: async () => prisma,
    storage,
    sources,
    // 阶段二：文件级 AES-256-GCM 加密（MEDIA_ENCRYPTION_KEY 独立 env；测试注入密钥）
    mediaCipher: createMediaFileCipher(TEST_MEDIA_KEY),
  });

  // 学生（owner A）——证据关联测试用
  await prisma.student.create({
    data: {
      id: STUDENT_A,
      teacherId: TEACHER_A,
      name: '媒体测试学生',
      grade: 'grade-1',
      currentStatus: 'active',
      createdAtTs: new Date(),
      updatedAtTs: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT_A } });
  await prisma.$disconnect();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

function tinyPng(): Buffer {
  return pngContent();
}

describe('media 服务：上传校验（白名单/大小/魔数）', () => {
  it('合法 PNG 上传成功：DB 行 + 磁盘文件 + DTO 完整', async () => {
    const content = tinyPng();
    const result = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'photo.png',
      mimeType: 'image/png',
      content,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.value;
    expect(dto.mediaType).toBe('image');
    expect(dto.mimeType).toBe('image/png'); // 服务端嗅探为准
    expect(dto.sizeBytes).toBe(content.length);
    expect(dto.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dto.privacyLevel).toBe('S1'); // 保守默认
    expect(dto.scanStatus).toBe('skipped');
    expect(dto.transcriptionStatus).toBe('none'); // 阶段二占位默认
    expect(dto.encryptionVersion).toBe('aes-256-gcm'); // 阶段二文件级加密
    expect(dto.orphanStatus).toBe('active');
    expect(dto.duplicateOf).toBeNull();
    expect(dto.originalPath).toBe(`media/${TEACHER_A}/${dto.id}/original`);
    expect(dto.createdAtTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 磁盘文件为密文（enc 头 + 密文，非明文）——阶段一明文静态风险关闭
    const onDisk = await readFile(join(tempRoot, dto.originalPath));
    expect(isMediaEncryptedFile(onDisk)).toBe(true);
    expect(onDisk.equals(content)).toBe(false);
    // 解密后 = 明文
    const plain = createMediaFileCipher(TEST_MEDIA_KEY).decrypt(onDisk);
    expect(plain.equals(content)).toBe(true);
  });

  it('JPEG / WebP 魔数同样接受', async () => {
    const jpeg = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'screenshot',
      originalFilename: 'shot.jpg',
      mimeType: 'image/jpeg',
      content: JPEG_CONTENT,
    });
    expect(jpeg.ok).toBe(true);
    if (!jpeg.ok) return;
    expect(jpeg.value.mimeType).toBe('image/jpeg');

    const webp = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'pic.webp',
      mimeType: 'image/webp',
      content: WEBP_CONTENT,
    });
    expect(webp.ok).toBe(true);
    if (!webp.ok) return;
    expect(webp.value.mimeType).toBe('image/webp');
  });

  it('拒绝非图片魔数（文本内容伪装 png）', async () => {
    const result = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'fake.png',
      mimeType: 'image/png',
      content: TEXT_CONTENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('audio 需音频魔数（PNG 内容伪装 audio → 拒绝）；非法 mediaType 拒绝', async () => {
    const fakeAudio = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'audio',
      originalFilename: 'voice.mp3',
      mimeType: 'audio/mp3',
      content: tinyPng(), // PNG 魔数 → audio 嗅探失败
    });
    expect(fakeAudio.ok).toBe(false);
    if (fakeAudio.ok) return;
    expect(fakeAudio.error.code).toBe('VALIDATION_ERROR');
    expect(fakeAudio.error.message).toContain('音频');

    const bogus = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'video',
      originalFilename: 'x.mp4',
      mimeType: 'video/mp4',
      content: tinyPng(),
    });
    expect(bogus.ok).toBe(false);
    if (bogus.ok) return;
    expect(bogus.error.code).toBe('VALIDATION_ERROR');
  });

  it('拒绝超过 10MB 的文件（服务层防线）', async () => {
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(10 * 1024 * 1024 + 1, 1)]);
    const result = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'big.png',
      mimeType: 'image/png',
      content: big,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('10MB');
  });

  it('缺 MEDIA_ENCRYPTION_KEY → 拒绝明文落盘（SAFETY_BLOCK）', async () => {
    const noCipherService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      // 不注入 mediaCipher（模拟 env 未配 MEDIA_ENCRYPTION_KEY）
    });
    const result = await noCipherService.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'plain.png',
      mimeType: 'image/png',
      content: tinyPng(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('SAFETY_BLOCK');
    expect(result.error.message).toContain('MEDIA_ENCRYPTION_KEY');
  });
});

describe('media 服务：幂等去重 + S1 标记', () => {
  it('同内容二次上传 → duplicateOf 指向已有资产，不重复落盘', async () => {
    const content = pngContent('dedup');
    const first = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'a.png',
      mimeType: 'image/png',
      content,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'a-copy.png',
      mimeType: 'image/png',
      content,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.duplicateOf).toBe(first.value.id);
    expect(second.value.originalPath).toBe(first.value.originalPath);

    // 仅 1 行 1 文件
    const rows = await prisma.mediaAsset.count({ where: { teacherId: TEACHER_A, sha256: first.value.sha256 } });
    expect(rows).toBe(1);
  });

  it('同内容不同教师 → 不视为重复（per-teacher 去重）', async () => {
    const content = pngContent('cross-teacher');
    const a = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'x.png',
      mimeType: 'image/png',
      content,
    });
    const b = await service.upload({
      teacherId: TEACHER_B,
      mediaType: 'image',
      originalFilename: 'x.png',
      mimeType: 'image/png',
      content,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.id).not.toBe(b.value.id);
    expect(b.value.duplicateOf).toBeNull();
  });
});

describe('media 服务：owner 隔离与受控下载', () => {
  it('教师 B 读不到教师 A 的资产（getOwned/readFile → NOT_FOUND）', async () => {
    const uploaded = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'private.png',
      mimeType: 'image/png',
      content: tinyPng(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const bOwned = await service.getOwned(TEACHER_B, uploaded.value.id);
    expect(bOwned.ok).toBe(false);
    if (bOwned.ok) return;
    expect(bOwned.error.code).toBe('NOT_FOUND');

    const bFile = await service.readFile(TEACHER_B, uploaded.value.id);
    expect(bFile.ok).toBe(false);
  });

  it('受控下载：owner 拿到原字节 + 元数据', async () => {
    const content = pngContent('download');
    const uploaded = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'dl.png',
      mimeType: 'image/png',
      content,
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const file = await service.readFile(TEACHER_A, uploaded.value.id);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.content.equals(content)).toBe(true);
    expect(file.value.row.mimeType).toBe('image/png');
  });

  it('不存在资产 → NOT_FOUND', async () => {
    const missing = await service.readFile(TEACHER_A, 'asset_does_not_exist_000');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');
  });
});

describe('media 服务：证据关联（sourceEntityType=MediaAsset 幂等）', () => {
  it('上传带 studentId → 自动捕获 StudentSourceRecord；重复捕获幂等', async () => {
    const uploaded = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'screenshot',
      originalFilename: 'chat.png',
      mimeType: 'image/png',
      content: tinyPng(),
      studentId: STUDENT_A,
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const rows = await prisma.studentSourceRecord.findMany({
      where: { teacherId: TEACHER_A, sourceEntityType: 'MediaAsset', sourceEntityId: uploaded.value.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe('screenshot');
    expect(rows[0].studentId).toBe(STUDENT_A);
    expect(rows[0].captureStatus).toBe('captured');

    // 幂等：再次捕获返回同一记录，不重复建行
    const again = await service.captureEvidence({
      teacherId: TEACHER_A,
      assetId: uploaded.value.id,
      studentId: STUDENT_A,
    });
    expect(again.ok).toBe(true);
    const rowsAfter = await prisma.studentSourceRecord.count({
      where: { teacherId: TEACHER_A, sourceEntityType: 'MediaAsset', sourceEntityId: uploaded.value.id },
    });
    expect(rowsAfter).toBe(1);
  });
});

// ---- 路由层：真实 HTTP（supertest）+ formidable 解析 ----

const stubAuth: AuthService = {
  register: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  login: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  logout: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  getMe: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  validateToken: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  verifyCredentials: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
};

function buildMediaApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(createMediaRouter(service, stubAuth));
  return app;
}

describe('media 路由：POST /api/v1/media（真实 multipart）', () => {
  it('上传成功 → 201 + DTO（S1 标记、sha256、证据关联）', async () => {
    const content = pngContent('route-upload');
    const res = await request(buildMediaApp())
      .post('/media')
      .set('x-teacher-id', TEACHER_A)
      .field('mediaType', 'image')
      .field('studentId', STUDENT_A)
      .attach('file', content, { filename: 'route.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    const payload = res.body as { ok: boolean; data: { privacyLevel: string; mediaType: string; sha256: string; id: string } };
    expect(payload.ok).toBe(true);
    expect(payload.data.privacyLevel).toBe('S1');
    expect(payload.data.mediaType).toBe('image');
    expect(payload.data.sha256).toMatch(/^[a-f0-9]{64}$/);

    // 证据关联：sourceEntityType=MediaAsset 已捕获
    const captured = await prisma.studentSourceRecord.count({
      where: { teacherId: TEACHER_A, sourceEntityType: 'MediaAsset', sourceEntityId: payload.data.id },
    });
    expect(captured).toBe(1);
  });

  it('魔数不符 → 400 VALIDATION_ERROR（formidable 解析后服务层拒绝）', async () => {
    const res = await request(buildMediaApp())
      .post('/media')
      .set('x-teacher-id', TEACHER_A)
      .field('mediaType', 'image')
      .attach('file', TEXT_CONTENT, { filename: 'fake.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('超过大小上限 → 400（formidable 流式中断）', async () => {
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(10 * 1024 * 1024 + 1024, 7)]);
    const res = await request(buildMediaApp())
      .post('/media')
      .set('x-teacher-id', TEACHER_A)
      .field('mediaType', 'image')
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('未认证（无 x-teacher-id 且非生产）→ 401', async () => {
    const res = await request(buildMediaApp())
      .post('/media')
      .field('mediaType', 'image')
      .attach('file', tinyPng(), { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});

describe('media 路由：GET /api/v1/media/:assetId（元数据）', () => {
  it('owner 200：元数据完整（originalPath 为相对路径，无绝对路径泄漏）', async () => {
    const content = pngContent('route-metadata');
    const uploaded = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'meta.png',
      mimeType: 'image/png',
      content,
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const res = await request(buildMediaApp())
      .get(`/media/${uploaded.value.id}`)
      .set('x-teacher-id', TEACHER_A);
    expect(res.status).toBe(200);
    const data = res.body as {
      ok: boolean;
      data: {
        id: string;
        mediaType: string;
        sha256: string;
        mimeType: string;
        sizeBytes: number;
        privacyLevel: string;
        scanStatus: string;
        createdAtTs: string;
        duplicateOf: string | null;
        originalPath: string;
      };
    };
    expect(data.ok).toBe(true);
    expect(data.data.id).toBe(uploaded.value.id);
    expect(data.data.mediaType).toBe('image');
    expect(data.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.data.mimeType).toBe('image/png');
    expect(data.data.sizeBytes).toBe(content.length);
    expect(data.data.privacyLevel).toBe('S1');
    expect(data.data.scanStatus).toBe('skipped');
    expect(data.data.createdAtTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.data.duplicateOf).toBeNull();
    // originalPath 为相对路径（media/<teacherId>/<assetId>/original），禁绝对路径
    expect(data.data.originalPath).toBe(`media/${TEACHER_A}/${uploaded.value.id}/original`);
    expect(data.data.originalPath).not.toMatch(/^[A-Za-z]:[\\/]/);
    expect(data.data.originalPath).not.toMatch(/^[\\/]/);
  });

  it('跨教师 → 404（防探测同现有模式）', async () => {
    const uploaded = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'meta-a.png',
      mimeType: 'image/png',
      content: tinyPng(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const res = await request(buildMediaApp())
      .get(`/media/${uploaded.value.id}`)
      .set('x-teacher-id', TEACHER_B);
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('不存在资产 → 404', async () => {
    const res = await request(buildMediaApp())
      .get('/media/asset_does_not_exist_000')
      .set('x-teacher-id', TEACHER_A);
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('未登录（无 x-teacher-id 且非生产）→ 401', async () => {
    const res = await request(buildMediaApp()).get('/media/asset_any');
    expect(res.status).toBe(401);
  });
});

describe('media 路由：GET /api/v1/media/:assetId/file（受控下载）', () => {
  it('owner 下载原字节 + Content-Type；跨教师 404', async () => {
    const content = pngContent('route-download');
    const uploaded = await service.upload({
      teacherId: TEACHER_A,
      mediaType: 'image',
      originalFilename: 'dl.png',
      mimeType: 'image/png',
      content,
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const app = buildMediaApp();
    const okRes = await request(app).get(`/media/${uploaded.value.id}/file`).set('x-teacher-id', TEACHER_A);
    expect(okRes.status).toBe(200);
    expect(okRes.headers['content-type']).toBe('image/png');
    expect(okRes.body.equals(content)).toBe(true);

    const forbidden = await request(app).get(`/media/${uploaded.value.id}/file`).set('x-teacher-id', TEACHER_B);
    expect(forbidden.status).toBe(404);
  });
});
