/**
 * P9 S3 阶段二（t3）功能测试：文件加密落盘/解密下载、孤儿回收（引用保护/保留期清理）、
 * 转写/扫描状态流转占位。
 *
 * 覆盖：
 * - 加密：上传落盘为密文（enc 头）、读回解密 = 明文；路由受控下载输出明文；
 * - 遗留明文双读：阶段一明文文件（无 enc 头）读路径直通；
 * - 孤儿回收：未被 StudentSourceRecord/FeedbackEvidence 引用 → 标记 orphan；
 *   被引用 → 不标记；标记后新引用 → 保护恢复 active；超保留期 → 物理删除文件+行；
 *   保留期内 → 保留；清理前被引用 → 保护跳过。
 * - 状态流转：transcriptionStatus / scanStatus 状态机合法流转与非法拒绝。
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { ok } from '@teacher-platform/contracts';
import { createStorage } from '../../../src/shared/storage/index.js';
import {
  createMediaAssetService,
  createMediaFileCipher,
  createMediaOrphanReaper,
  isMediaEncryptedFile,
} from '../../../src/features/media/index.js';
import type { TrustedClock } from '../../../src/shared/trusted-clock/types.js';
import { createMediaRouter } from '../../../src/app/routes/media.routes.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import type { AuthService } from '../../../src/features/auth/index.js';

const prisma = new PrismaClient();

const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const cipher = createMediaFileCipher(TEST_MEDIA_KEY);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngContent(seed = 'png'): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(`p2-${seed}-${randomBytes(4).toString('hex')}`)]);
}

const TEACHER = `teacher_p2_${randomBytes(4).toString('hex')}`;
const STUDENT = `student_p2_${randomBytes(4).toString('hex')}`;

let tempRoot: string;
let service: ReturnType<typeof createMediaAssetService>;
let sources: ReturnType<typeof createStudentSourceRecordService>;
let storage: ReturnType<typeof createStorage>;

/** 可控假时钟（孤儿回收时间纪律：不引入未登记 new Date——测试注入可信时钟源）。 */
function fakeClock(start: Date): { clock: TrustedClock; advance: (ms: number) => void } {
  let current = start;
  return {
    clock: { now: async () => ok(new Date(current)) },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'media-p2-test-'));
  storage = createStorage({ rootDir: tempRoot });
  sources = createStudentSourceRecordService(prisma);
  service = createMediaAssetService({
    getClient: async () => prisma,
    storage,
    sources,
    mediaCipher: cipher,
  });
  await prisma.student.create({
    data: {
      id: STUDENT,
      teacherId: TEACHER,
      name: '阶段二测试学生',
      grade: 'grade-1',
      currentStatus: 'active',
      createdAtTs: new Date(),
      updatedAtTs: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.feedbackEvidence.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.student.deleteMany({ where: { id: STUDENT } });
  await prisma.$disconnect();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe('阶段二：文件级 AES-256-GCM 加密落盘 + 解密读取', () => {
  it('上传 → 磁盘密文（enc 头 + 非明文）+ DTO 标 encryptionVersion=aes-256-gcm', async () => {
    const content = pngContent('enc');
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'enc.png',
      mimeType: 'image/png',
      content,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.value;
    expect(dto.encryptionVersion).toBe('aes-256-gcm');

    const onDisk = await readFile(join(tempRoot, dto.originalPath));
    expect(isMediaEncryptedFile(onDisk)).toBe(true);
    expect(onDisk.equals(content)).toBe(false); // 明文永不经磁盘
    expect(cipher.decrypt(onDisk).equals(content)).toBe(true); // 解密回明文
  });

  it('受控下载：服务层解密输出明文，owner 拿到原字节', async () => {
    const content = pngContent('dl');
    const uploaded = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'dl.png',
      mimeType: 'image/png',
      content,
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const file = await service.readFile(TEACHER, uploaded.value.id);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.content.equals(content)).toBe(true);
  });

  it('路由：GET /file 输出解密明文（HTTP 层流式响应原字节）', async () => {
    const content = pngContent('route');
    const uploaded = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'route.png',
      mimeType: 'image/png',
      content,
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const stubAuth: AuthService = {
      register: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
      login: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
      logout: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
      getMe: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
      validateToken: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
      verifyCredentials: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
    };
    const app = express();
    app.use(express.json());
    app.use(createMediaRouter(service, stubAuth));

    const res = await request(app).get(`/media/${uploaded.value.id}/file`).set('x-teacher-id', TEACHER);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.equals(content)).toBe(true); // 响应为解密明文
  });

  it('遗留明文双读：阶段一明文文件（无 enc 头）读路径直通', async () => {
    // 模拟阶段一遗留：明文直接落盘 + 行 encryptionVersion=null
    const content = pngContent('legacy');
    const assetId = `asset_legacy_${randomBytes(6).toString('hex')}`;
    const originalPath = `media/${TEACHER}/${assetId}/original`;
    const saved = await storage.save({ exactRef: originalPath, filename: 'original', content });
    expect(saved.ok).toBe(true);
    const row = await prisma.mediaAsset.create({
      data: {
        id: assetId,
        teacherId: TEACHER,
        mediaType: 'image',
        sha256: 'a'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: content.length,
        privacyLevel: 'S1',
        scanStatus: 'skipped',
        transcriptionStatus: 'none',
        encryptionVersion: null, // 阶段一明文遗留
        originalPath,
        createdAtTs: new Date(),
      },
    });
    expect(row.encryptionVersion).toBeNull();

    const file = await service.readFile(TEACHER, assetId);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.content.equals(content)).toBe(true); // 明文直通
    expect(file.value.row.encryptionVersion).toBeNull();
  });
});

describe('阶段二：孤儿回收（引用保护 + 保留期清理）', () => {
  async function uploadUnreferenced(seed: string): Promise<string> {
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: `${seed}.png`,
      mimeType: 'image/png',
      content: pngContent(seed),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('upload failed');
    return result.value.id;
  }

  it('未被引用资产 → markOrphans 标记 orphan（状态 + 可信时刻）', async () => {
    const assetId = await uploadUnreferenced('orphan1');
    const { clock, advance } = fakeClock(new Date('2026-06-01T00:00:00.000Z'));
    const reaper = createMediaOrphanReaper({
      getClient: async () => prisma,
      storage,
      trustedClock: clock,
      retentionMs: 1000,
    });
    const res = await reaper.markOrphans();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.marked).toBeGreaterThanOrEqual(1);

    const row = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(row?.orphanStatus).toBe('orphan');
    expect(row?.orphanMarkedAtTs?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    void advance;
  });

  it('被 StudentSourceRecord 引用 → 不标记 orphan（引用保护）', async () => {
    const assetId = await uploadUnreferenced('ref-source');
    const captured = await service.captureEvidence({
      teacherId: TEACHER,
      assetId,
      studentId: STUDENT,
    });
    expect(captured.ok).toBe(true);

    const reaper = createMediaOrphanReaper({
      getClient: async () => prisma,
      storage,
      trustedClock: { now: async () => ok(new Date('2026-06-01T00:00:00.000Z')) },
    });
    const res = await reaper.markOrphans();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(row?.orphanStatus).toBe('active');
    expect(row?.orphanMarkedAtTs).toBeNull();
  });

  it('被 FeedbackEvidence 引用 → 不标记 orphan（快照引用保护）', async () => {
    const assetId = await uploadUnreferenced('ref-evidence');
    const feedbackId = `fb_${randomBytes(6).toString('hex')}`;
    const snapshotId = `snap_${randomBytes(6).toString('hex')}`;
    await prisma.parentFeedback.create({
      data: {
        id: feedbackId,
        teacherId: TEACHER,
        studentId: STUDENT,
        title: '测试反馈',
        content: '内容',
        status: 'draft',
        createdAtTs: new Date(),
        updatedAtTs: new Date(),
      },
    });
    await prisma.feedbackContextSnapshot.create({
      data: {
        id: snapshotId,
        teacherId: TEACHER,
        feedbackId,
        assembledAtTs: new Date(),
        createdAtTs: new Date(),
        updatedAtTs: new Date(),
      },
    });
    await prisma.feedbackEvidence.create({
      data: {
        id: `ev_${randomBytes(6).toString('hex')}`,
        teacherId: TEACHER,
        snapshotId,
        type: 'media',
        mediaAssetId: assetId,
        sortOrder: 0,
        occurredAtTs: new Date(),
        createdAtTs: new Date(),
      },
    });

    const reaper = createMediaOrphanReaper({
      getClient: async () => prisma,
      storage,
      trustedClock: { now: async () => ok(new Date('2026-06-01T00:00:00.000Z')) },
    });
    const res = await reaper.markOrphans();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(row?.orphanStatus).toBe('active');
  });

  it('标记后新引用 → 保护恢复 active（保留期作废）', async () => {
    const assetId = await uploadUnreferenced('restore');
    const { clock, advance } = fakeClock(new Date('2026-06-01T00:00:00.000Z'));
    const reaper = createMediaOrphanReaper({
      getClient: async () => prisma,
      storage,
      trustedClock: clock,
      retentionMs: 1000,
    });
    await reaper.markOrphans();
    let row = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(row?.orphanStatus).toBe('orphan');

    // 标记后被引用（captureEvidence）→ 下一轮 markOrphans 恢复 active
    await service.captureEvidence({ teacherId: TEACHER, assetId, studentId: STUDENT });
    advance(5000);
    const res = await reaper.markOrphans();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.restored).toBeGreaterThanOrEqual(1);
    row = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(row?.orphanStatus).toBe('active');
    expect(row?.orphanMarkedAtTs).toBeNull();
  });

  it('超保留期 → 物理删除文件 + 行；保留期内 → 保留', async () => {
    const expiredId = await uploadUnreferenced('expired');
    const { clock, advance } = fakeClock(new Date('2026-06-01T00:00:00.000Z'));
    const reaper = createMediaOrphanReaper({
      getClient: async () => prisma,
      storage,
      trustedClock: clock,
      retentionMs: 10_000,
    });
    await reaper.markOrphans(); // expired 于 t0 标记

    // 时间推进 15s（>保留期 10s），再上传并标记 fresh → fresh 于 t0+15s 标记（保留期内）
    advance(15_000);
    const freshId = await uploadUnreferenced('fresh');
    await reaper.markOrphans();

    const res = await reaper.cleanupExpired();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.deleted).toBeGreaterThanOrEqual(1);

    const expiredRow = await prisma.mediaAsset.findUnique({ where: { id: expiredId } });
    expect(expiredRow).toBeNull();
    const freshRow = await prisma.mediaAsset.findUnique({ where: { id: freshId } });
    expect(freshRow?.orphanStatus).toBe('orphan'); // 仍在保留期内
    expect(freshRow?.orphanMarkedAtTs?.toISOString()).toBe('2026-06-01T00:00:15.000Z');

    // 文件已物理删除（expired 的 original 文件不存在）
    await expect(readFile(join(tempRoot, `media/${TEACHER}/${expiredId}/original`))).rejects.toThrow();
    // fresh 文件仍在
    await expect(readFile(join(tempRoot, `media/${TEACHER}/${freshId}/original`))).resolves.toBeDefined();
  });

  it('清理前被引用 → 保护跳过（快照引用保护不变式）', async () => {
    const assetId = await uploadUnreferenced('protected-cleanup');
    const { clock, advance } = fakeClock(new Date('2026-06-01T00:00:00.000Z'));
    const reaper = createMediaOrphanReaper({
      getClient: async () => prisma,
      storage,
      trustedClock: clock,
      retentionMs: 1000,
    });
    await reaper.markOrphans();

    // 超保留期前被引用（FeedbackEvidence 锚点）
    const feedbackId = `fb_${randomBytes(6).toString('hex')}`;
    const snapshotId = `snap_${randomBytes(6).toString('hex')}`;
    await prisma.parentFeedback.create({
      data: {
        id: feedbackId,
        teacherId: TEACHER,
        studentId: STUDENT,
        title: '保护测试',
        content: '内容',
        status: 'draft',
        createdAtTs: new Date(),
        updatedAtTs: new Date(),
      },
    });
    await prisma.feedbackContextSnapshot.create({
      data: {
        id: snapshotId,
        teacherId: TEACHER,
        feedbackId,
        assembledAtTs: new Date(),
        createdAtTs: new Date(),
        updatedAtTs: new Date(),
      },
    });
    await prisma.feedbackEvidence.create({
      data: {
        id: `ev_${randomBytes(6).toString('hex')}`,
        teacherId: TEACHER,
        snapshotId,
        type: 'media',
        mediaAssetId: assetId,
        sortOrder: 0,
        occurredAtTs: new Date(),
        createdAtTs: new Date(),
      },
    });

    advance(5000);
    const res = await reaper.cleanupExpired();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(row).not.toBeNull(); // 未被删
    expect(row?.orphanStatus).toBe('active'); // 保护恢复
    await expect(readFile(join(tempRoot, `media/${TEACHER}/${assetId}/original`))).resolves.toBeDefined();
  });
});

describe('阶段二：转写/扫描状态流转占位（状态机）', () => {
  async function upload(seed: string): Promise<string> {
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: `${seed}.png`,
      mimeType: 'image/png',
      content: pngContent(seed),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('upload failed');
    return result.value.id;
  }

  it('transcriptionStatus：none→pending→completed 合法；none→completed 非法拒绝', async () => {
    const assetId = await upload('tx');
    const pending = await service.updateTranscriptionStatus(TEACHER, assetId, 'pending');
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.transcriptionStatus).toBe('pending');

    const completed = await service.updateTranscriptionStatus(TEACHER, assetId, 'completed');
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.transcriptionStatus).toBe('completed');

    // 终态后再流转 → 拒绝
    const invalid = await service.updateTranscriptionStatus(TEACHER, assetId, 'failed');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.error.message).toContain('非法流转');
  });

  it('transcriptionStatus：failed→pending 重试合法；非法值拒绝', async () => {
    const assetId = await upload('tx-retry');
    await service.updateTranscriptionStatus(TEACHER, assetId, 'pending');
    const failed = await service.updateTranscriptionStatus(TEACHER, assetId, 'failed');
    expect(failed.ok).toBe(true);

    const retry = await service.updateTranscriptionStatus(TEACHER, assetId, 'pending');
    expect(retry.ok).toBe(true);

    const bogus = await service.updateTranscriptionStatus(TEACHER, assetId, 'done' as never);
    expect(bogus.ok).toBe(false);
    if (bogus.ok) return;
    expect(bogus.error.code).toBe('VALIDATION_ERROR');
  });

  it('scanStatus：skipped→pending→clean 合法；skipped→infected 非法拒绝', async () => {
    const assetId = await upload('scan');
    const pending = await service.updateScanStatus(TEACHER, assetId, 'pending');
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.scanStatus).toBe('pending');

    const clean = await service.updateScanStatus(TEACHER, assetId, 'clean');
    expect(clean.ok).toBe(true);

    // 阶段一 skipped → infected 直接跳转非法
    const asset2 = await upload('scan2');
    const invalid = await service.updateScanStatus(TEACHER, asset2, 'infected');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.error.message).toContain('非法流转');
  });

  it('跨教师更新状态 → NOT_FOUND（owner 隔离）', async () => {
    const assetId = await upload('owner');
    const other = await service.updateTranscriptionStatus('teacher_other_p2', assetId, 'pending');
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe('NOT_FOUND');
  });
});
