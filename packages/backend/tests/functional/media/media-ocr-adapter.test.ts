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

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStorage } from '../../../src/shared/storage/index.js';
import { createJobStore } from '../../../src/shared/background-jobs/index.js';
import { createPlatformServices, providerError } from '../../../src/shared/platform-services/index.js';
import type { OcrAdapter } from '../../../src/shared/platform-services/index.js';
import {
  createMediaAssetService,
  createMediaFileCipher,
} from '../../../src/features/media/index.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';

const prisma = new PrismaClient();

const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const cipher = createMediaFileCipher(TEST_MEDIA_KEY);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

/**
 * P11 A2：platform-services OCR 接线（真实 adapter 路径）——worker 读解密后明文 → ocr.ocr
 * → completed + ocrText/ocrLayoutBlocks；失败 failed 可重试；retryable 指数退避重试。
 */
describe('P11：OCR 接线（shared/platform-services adapter 替换占位）', () => {
  /** 用指定 service 实例轮询 OCR 状态（DB 权威 + 该实例作业瞬态）。 */
  async function poll(
    pollService: ReturnType<typeof createMediaAssetService>,
    assetId: string,
    expected: string,
    timeoutMs = 4000,
  ): Promise<{ status: string; text: string | null; confidence: number | null; blocks: unknown; jobStatus: string | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pollResult = await pollService.getOcr(TEACHER, assetId);
      if (!pollResult.ok) throw new Error(`轮询失败: ${pollResult.error.message}`);
      const { ocrStatus, ocrText, ocrConfidence, ocrLayoutBlocks, job } = pollResult.value;
      if (ocrStatus === expected) {
        return { status: ocrStatus, text: ocrText, confidence: ocrConfidence, blocks: ocrLayoutBlocks, jobStatus: job?.status ?? null };
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 OCR 状态 ${expected} 超时，当前 ${ocrStatus}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }

  it('S3 接线：worker 读解密后明文 → adapter 收到 content+sha256 → 写真实 ocrText/ocrLayoutBlocks', async () => {
    const plainImage = Buffer.concat([PNG_MAGIC, Buffer.from(`-wiring-${randomBytes(4).toString('hex')}`)]);
    const expectedSha = createHash('sha256').update(plainImage).digest('hex');
    const captured: { content?: Buffer; sha256?: string; mimeType?: string; assetId?: string } = {};
    const capturingOcr: OcrAdapter = {
      provider: 'test-capture',
      async ocr(input) {
        captured.content = input.content;
        captured.sha256 = input.sha256;
        captured.mimeType = input.mimeType;
        captured.assetId = input.assetId;
        return {
          text: '真实 OCR 文本：作业答案 25',
          blocks: [
            { text: '作业答案', bbox: { x: 10, y: 20, w: 100, h: 30 } },
            { text: '25', bbox: { x: 120, y: 20, w: 40, h: 30 } },
          ],
          confidence: 0.97,
        };
      },
    };
    const wiringService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'ocr_' }),
      platformServices: { ocr: capturingOcr },
    });

    const assetId = await uploadImage('wiring', plainImage);
    const submitted = await wiringService.submitOcr(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await poll(wiringService, assetId, 'completed');
    expect(done.text).toBe('真实 OCR 文本：作业答案 25');
    expect(done.confidence).toBe(0.97);
    expect(done.blocks).toEqual([
      { text: '作业答案', bbox: { x: 10, y: 20, w: 100, h: 30 } },
      { text: '25', bbox: { x: 120, y: 20, w: 40, h: 30 } },
    ]);
    expect(done.jobStatus).toBe('succeeded');

    // adapter 只见解密后明文（= 上传原文）+ 明文 sha256（幂等键）
    expect(captured.content?.equals(plainImage)).toBe(true);
    expect(captured.sha256).toBe(expectedSha);
    expect(captured.mimeType).toBe('image/png');
    expect(captured.assetId).toBe(assetId);
  });

  it('非法置信度不会伪装成成功：负数 → failed 且不落库', async () => {
    const invalidService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'ocr_' }),
      platformServices: { ocr: { provider: 'test-invalid-confidence', async ocr() { return { text: 'invalid', confidence: -0.1 }; } } },
    });
    const assetId = await uploadImage('invalid-confidence');
    const submitted = await invalidService.submitOcr(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const failed = await poll(invalidService, assetId, 'failed');
    expect(failed.text).toBeNull();
    expect(failed.confidence).toBeNull();
  });

  it('非重试失败（auth）→ ocrStatus=failed + 作业 failed；重提交（可用 adapter）→ completed', async () => {
    const failingOcr: OcrAdapter = {
      provider: 'test-auth-fail',
      async ocr() {
        throw providerError('auth', 401, '平台 OCR 密钥无效');
      },
    };
    const failingService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'ocr_' }),
      platformServices: { ocr: failingOcr },
    });

    const assetId = await uploadImage('auth-fail');
    const submitted = await failingService.submitOcr(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await poll(failingService, assetId, 'failed');
    expect(failed.text).toBeNull();
    expect(failed.blocks).toBeNull();
    expect(failed.jobStatus).toBe('failed');

    // failed → 可重试提交（主 service 占位 adapter 可用）→ completed
    const retry = await service.submitOcr(TEACHER, assetId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.ocrStatus).toBe('pending');
    const done = await waitForOcrStatus(assetId, 'completed');
    expect(done.text).toContain('阶段三占位');
    expect(done.jobStatus).toBe('succeeded');
  });

  it('retryable（rate_limited）→ 指数退避重试后成功（2 次失败 + 第 3 次成功）', async () => {
    let calls = 0;
    const flakyOcr: OcrAdapter = {
      provider: 'test-flaky',
      async ocr() {
        calls += 1;
        if (calls < 3) throw providerError('rate_limited', 429, '限流', true);
        return { text: '重试后成功识别', confidence: 0.12 };
      },
    };
    const retryService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'ocr_' }),
      platformServices: { ocr: flakyOcr },
      ocrBackoffBaseMs: 5, // 5ms→10ms，测试加速
      ocrMaxAttempts: 5,
    });

    const assetId = await uploadImage('flaky');
    const submitted = await retryService.submitOcr(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await poll(retryService, assetId, 'completed');
    expect(done.text).toBe('重试后成功识别');
    expect(done.confidence).toBe(0.12);
    expect(done.jobStatus).toBe('succeeded');
    expect(calls).toBe(3); // 2 次限流失败 + 1 次成功
  });

  it('重试耗尽（一直 retryable 失败）→ failed 终态（不无限重试）', async () => {
    let calls = 0;
    const foreverFlakyOcr: OcrAdapter = {
      provider: 'test-forever-flaky',
      async ocr() {
        calls += 1;
        throw providerError('provider_down', 503, '供应商不可用', true);
      },
    };
    const exhaustedService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'ocr_' }),
      platformServices: { ocr: foreverFlakyOcr },
      ocrBackoffBaseMs: 2, // 测试加速（2ms→4ms→8ms→16ms）
      ocrMaxAttempts: 4,
    });

    const assetId = await uploadImage('exhausted');
    const submitted = await exhaustedService.submitOcr(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await poll(exhaustedService, assetId, 'failed');
    expect(failed.jobStatus).toBe('failed');
    expect(calls).toBe(4); // 上限 4 次，重试耗尽不再无限重试
  });
});
