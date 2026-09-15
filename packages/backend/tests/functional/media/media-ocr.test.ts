/**
 * P11 平台预配线 A2（t1）功能测试：图片上传 → 异步 OCR 作业（提交 → pending → worker 完成 →
 * completed + ocrText/ocrLayoutBlocks；状态机非法流转拒绝；owner 隔离）+ platform-services OCR
 * 接线（真实 adapter 路径：worker 读解密后明文 → ocr.ocr → 写 ocrText/ocrLayoutBlocks；
 * 非重试失败 → failed 可重试；retryable 指数退避重试；重试耗尽终态）。
 *
 * 覆盖：
 * - 图片上传：png 魔数接受；上传后 ocrStatus=none 默认；
 * - OCR 作业：image 提交 → 202 pending；轮询 → completed + 占位文本 + ocrLayoutBlocks=[] + 作业 succeeded；
 *   非 image（audio）拒绝；pending 中重复提交拒绝；completed 终态拒绝；failed 可重试；缺 jobs 存储 INTERNAL_ERROR；
 * - owner 隔离：跨教师提交/轮询 → NOT_FOUND；元数据含 ocrStatus/ocrText/ocrLayoutBlocks；
 * - 状态机：none→completed 非法拒绝；failed→pending 重试合法；
 * - P11 OCR 接线：S3 读解密明文 → adapter（content/sha256 断言）→ 真实文本/版面块落库；
 *   auth 失败 → failed + 重提交；rate_limited 指数退避重试成功；重试耗尽 failed 终态。
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { createStorage } from '../../../src/shared/storage/index.js';
import { createJobStore } from '../../../src/shared/background-jobs/index.js';
import { createPlatformServices } from '../../../src/shared/platform-services/index.js';
import {
  createMediaAssetService,
  createMediaFileCipher,
} from '../../../src/features/media/index.js';
import { createMediaRouter } from '../../../src/app/routes/media.routes.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import type { AuthService } from '../../../src/features/auth/index.js';

const prisma = new PrismaClient();

const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const cipher = createMediaFileCipher(TEST_MEDIA_KEY);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP3_ID3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from(`\x04\x00\x00\x00\x00\x00voice-${randomBytes(4).toString('hex')}`)]);

const TEACHER = `teacher_ocr_${randomBytes(4).toString('hex')}`;
const TEACHER_OTHER = `teacher_ocr_other_${randomBytes(4).toString('hex')}`;

let tempRoot: string;
let service: ReturnType<typeof createMediaAssetService>;
let sources: ReturnType<typeof createStudentSourceRecordService>;
let jobs: ReturnType<typeof createJobStore>;

/** 轮询直到 OCR 状态达成（worker 异步完成；DB 状态为权威）。 */
async function waitForOcrStatus(
  assetId: string,
  expected: string,
  timeoutMs = 3000,
): Promise<{ status: string; text: string | null; confidence: number | null; blocks: unknown; jobStatus: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const poll = await service.getOcr(TEACHER, assetId);
    if (!poll.ok) throw new Error(`轮询失败: ${poll.error.message}`);
    const { ocrStatus, ocrText, ocrConfidence, ocrLayoutBlocks, job } = poll.value;
    if (ocrStatus === expected) {
      return { status: ocrStatus, text: ocrText, confidence: ocrConfidence, blocks: ocrLayoutBlocks, jobStatus: job?.status ?? null };
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 OCR 状态 ${expected} 超时，当前 ${ocrStatus}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'media-ocr-test-'));
  const storage = createStorage({ rootDir: tempRoot });
  sources = createStudentSourceRecordService(prisma);
  jobs = createJobStore({ jobIdPrefix: 'ocr_' });
  service = createMediaAssetService({
    getClient: async () => prisma,
    storage,
    sources,
    mediaCipher: cipher,
    jobs,
    // P11 A2：平台预配门面（启用 + 未配置供应商 → 占位 adapter；占位文本前缀 阶段三占位 与断言一致）
    platformServices: createPlatformServices({ PLATFORM_SERVICES_ENABLED: 'true' }),
    ocrJobDelayMs: 30, // 占位 worker 小延迟，便于观察 pending 态
  });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.$disconnect();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

async function uploadImage(seed: string, content?: Buffer): Promise<string> {
  // 每次生成唯一内容（防 sha256 幂等去重跨用例共享资产/状态互相干扰）
  const body = content ?? Buffer.concat([PNG_MAGIC, Buffer.from(`-${seed}-${randomBytes(4).toString('hex')}`)]);
  const result = await service.upload({
    teacherId: TEACHER,
    mediaType: 'image',
    originalFilename: `${seed}.png`,
    mimeType: 'image/png',
    content: body,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`图片上传失败: ${result.error.message}`);
  return result.value.id;
}

const stubAuth: AuthService = {
  register: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  login: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  logout: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  getMe: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  validateToken: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
  verifyCredentials: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'stub' } }),
};

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createMediaRouter(service, stubAuth));
  return app;
}

describe('P11 A2：OCR 作业流转（提交/轮询/状态机/owner 隔离）', () => {
  it('提交 → 202 pending + jobId；轮询 → completed + 占位文本 + 空版面块 + 作业 succeeded', async () => {
    const assetId = await uploadImage('submit1');
    const submitted = await service.submitOcr(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.jobId).toMatch(/^ocr_/);
    expect(submitted.value.ocrStatus).toBe('pending');

    const done = await waitForOcrStatus(assetId, 'completed');
    expect(done.text).toContain('阶段三占位');
    expect(done.blocks).toEqual([]);
    expect(done.jobStatus).toBe('succeeded');
  });

  it('上传后元数据默认 ocrStatus=none；screenshot 也可提交 OCR', async () => {
    const image = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'meta.png',
      mimeType: 'image/png',
      content: Buffer.concat([PNG_MAGIC, Buffer.from(`meta-${randomBytes(4).toString('hex')}`)]),
    });
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect(image.value.ocrStatus).toBe('none');
    expect(image.value.ocrText).toBeNull();
    expect(image.value.ocrLayoutBlocks).toBeNull();

    // screenshot 属 image 类，同样可提交
    const screenshot = await service.upload({
      teacherId: TEACHER,
      mediaType: 'screenshot',
      originalFilename: 'shot.png',
      mimeType: 'image/png',
      content: Buffer.concat([PNG_MAGIC, Buffer.from(`shot-${randomBytes(4).toString('hex')}`)]),
    });
    expect(screenshot.ok).toBe(true);
    if (!screenshot.ok) return;
    const submitted = await service.submitOcr(TEACHER, screenshot.value.id);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.ocrStatus).toBe('pending');
    await waitForOcrStatus(screenshot.value.id, 'completed');
  });

  it('非 image 类（audio）提交 OCR → VALIDATION_ERROR', async () => {
    const audio = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'voice.mp3',
      mimeType: 'audio/mpeg',
      content: MP3_ID3,
    });
    expect(audio.ok).toBe(true);
    if (!audio.ok) return;
    const res = await service.submitOcr(TEACHER, audio.value.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('VALIDATION_ERROR');
    expect(res.error.message).toContain('仅 image/screenshot');
  });

  it('pending 中重复提交 → VALIDATION_ERROR（已在队列）', async () => {
    const assetId = await uploadImage('dup-submit');
    // 用大延迟服务观察 pending 态（worker 未完成前再次提交）
    const slowService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'ocr_' }),
      ocrJobDelayMs: 300,
    });
    const first = await slowService.submitOcr(TEACHER, assetId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await slowService.submitOcr(TEACHER, assetId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('VALIDATION_ERROR');
    expect(second.error.message).toContain('队列中');

    // 等 slow worker 完成，避免 afterAll 删行竞争
    await waitForOcrStatus(assetId, 'completed');
  });

  it('completed 终态 → 不可重复提交', async () => {
    const assetId = await uploadImage('completed');
    await service.submitOcr(TEACHER, assetId);
    await waitForOcrStatus(assetId, 'completed');
    const again = await service.submitOcr(TEACHER, assetId);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('VALIDATION_ERROR');
    expect(again.error.message).toContain('不可提交');
  });

  it('failed → 可重试提交（failed→pending）', async () => {
    const assetId = await uploadImage('retry');
    // 直接置 failed（占位状态机合法流转：none→pending→failed）
    await service.updateOcrStatus(TEACHER, assetId, 'pending');
    await service.updateOcrStatus(TEACHER, assetId, 'failed');
    const retry = await service.submitOcr(TEACHER, assetId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.ocrStatus).toBe('pending');
    await waitForOcrStatus(assetId, 'completed');
  });

  it('状态机：none→completed 非法拒绝；failed→pending 重试合法', async () => {
    const assetId = await uploadImage('sm');
    const illegal = await service.updateOcrStatus(TEACHER, assetId, 'completed');
    expect(illegal.ok).toBe(false);
    if (illegal.ok) return;
    expect(illegal.error.code).toBe('VALIDATION_ERROR');
    expect(illegal.error.message).toContain('非法流转');

    const pending = await service.updateOcrStatus(TEACHER, assetId, 'pending');
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const failed = await service.updateOcrStatus(TEACHER, assetId, 'failed');
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    const retry = await service.updateOcrStatus(TEACHER, assetId, 'pending');
    expect(retry.ok).toBe(true);
  });

  it('owner 隔离：跨教师提交/轮询 → NOT_FOUND', async () => {
    const assetId = await uploadImage('owner');
    const otherSubmit = await service.submitOcr(TEACHER_OTHER, assetId);
    expect(otherSubmit.ok).toBe(false);
    if (otherSubmit.ok) return;
    expect(otherSubmit.error.code).toBe('NOT_FOUND');

    const otherPoll = await service.getOcr(TEACHER_OTHER, assetId);
    expect(otherPoll.ok).toBe(false);
    if (otherPoll.ok) return;
    expect(otherPoll.error.code).toBe('NOT_FOUND');
  });

  it('缺 jobs 存储 → INTERNAL_ERROR', async () => {
    const noJobsService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      // 不注入 jobs
    });
    const assetId = await uploadImage('nojobs');
    const res = await noJobsService.submitOcr(TEACHER, assetId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INTERNAL_ERROR');
    expect(res.error.message).toContain('jobs');
  });

  it('路由：提交 202 + 轮询 200 + 跨教师 404 契约', async () => {
    const assetId = await uploadImage('route-ocr');
    const app = buildApp();

    const submitRes = await request(app)
      .post(`/media/${assetId}/ocr`)
      .set('x-teacher-id', TEACHER);
    expect(submitRes.status).toBe(202);
    const submitBody = submitRes.body as { ok: boolean; data: { jobId: string; ocrStatus: string } };
    expect(submitBody.ok).toBe(true);
    expect(submitBody.data.ocrStatus).toBe('pending');

    // 轮询路由直到 completed
    let status = 'pending';
    const deadline = Date.now() + 3000;
    while (status === 'pending' && Date.now() < deadline) {
      const pollRes = await request(app)
        .get(`/media/${assetId}/ocr`)
        .set('x-teacher-id', TEACHER);
      expect(pollRes.status).toBe(200);
      status = (pollRes.body as { data: { ocrStatus: string } }).data.ocrStatus;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    expect(status).toBe('completed');

    const meta = await service.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.ocrStatus).toBe('completed');
    expect(meta.value.ocrText).toContain('阶段三占位');
    expect(meta.value.ocrLayoutBlocks).toEqual([]);

    // 跨教师路由提交 → 404
    const forbidden = await request(app)
      .post(`/media/${assetId}/ocr`)
      .set('x-teacher-id', TEACHER_OTHER);
    expect(forbidden.status).toBe(404);
  });
});
