/**
 * P9 S3 阶段二续（t6）+ P10 平台预配线 A1（t6）功能测试：audio 上传白名单（mp3/wav/m4a 魔数 + 30MB）
 * + 异步转写作业（提交 → pending → worker 完成 → completed + transcriptionText；状态机非法流转拒绝；owner 隔离）
 * + platform-services ASR 接线（真实 adapter 路径：worker 读解密后明文 → asr.transcribe → 写 transcriptionText；
 *   非重试失败 → failed 可重试；retryable 指数退避重试；重试耗尽终态）。
 *
 * 覆盖：
 * - audio 上传：mp3（ID3/帧同步）/wav/m4a 魔数接受；PNG 伪装 audio 拒绝；>30MB 拒绝；幂等去重；
 * - 转写作业：audio 提交 → 202 pending；轮询 → completed + 占位文本 + 作业 succeeded；
 *   非 audio 拒绝；pending 中重复提交拒绝；completed 终态拒绝；failed 可重试；缺 jobs 存储 INTERNAL_ERROR；
 * - owner 隔离：跨教师提交/轮询 → NOT_FOUND；元数据含 transcriptionStatus/transcriptionText；
 * - P10 ASR 接线：S3 读解密明文 → adapter（content/sha256 断言）→ 真实文本落库；auth 失败 → failed + 重提交；
 *   rate_limited 指数退避重试成功；重试耗尽 failed 终态。
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
import type { AsrAdapter } from '../../../src/shared/platform-services/index.js';
import {
  createMediaAssetService,
  createMediaFileCipher,
} from '../../../src/features/media/index.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';

const prisma = new PrismaClient();

const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const cipher = createMediaFileCipher(TEST_MEDIA_KEY);

const MP3_ID3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from(`\x04\x00\x00\x00\x00\x00voice-${randomBytes(4).toString('hex')}`)]);

const TEACHER = `teacher_t6_${randomBytes(4).toString('hex')}`;
const TEACHER_OTHER = `teacher_t6_other_${randomBytes(4).toString('hex')}`;

let tempRoot: string;
let service: ReturnType<typeof createMediaAssetService>;
let sources: ReturnType<typeof createStudentSourceRecordService>;
let jobs: ReturnType<typeof createJobStore>;

/** 轮询直到转写状态达成（worker 异步完成；DB 状态为权威）。 */
async function waitForTranscriptionStatus(
  assetId: string,
  expected: string,
  timeoutMs = 3000,
): Promise<{ status: string; text: string | null; confidence: number | null; jobStatus: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const poll = await service.getTranscription(TEACHER, assetId);
    if (!poll.ok) throw new Error(`轮询失败: ${poll.error.message}`);
    const { transcriptionStatus, transcriptionText, transcriptionConfidence, job } = poll.value;
    if (transcriptionStatus === expected) {
      return { status: transcriptionStatus, text: transcriptionText, confidence: transcriptionConfidence, jobStatus: job?.status ?? null };
    }
    if (Date.now() > deadline) {
      throw new Error(`等待转写状态 ${expected} 超时，当前 ${transcriptionStatus}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'media-t6-test-'));
  const storage = createStorage({ rootDir: tempRoot });
  sources = createStudentSourceRecordService(prisma);
  jobs = createJobStore({ jobIdPrefix: 'transc_' });
  service = createMediaAssetService({
    getClient: async () => prisma,
    storage,
    sources,
    mediaCipher: cipher,
    jobs,
    // P10 t6：平台预配门面（启用 + 未配置供应商 → 占位 adapter；占位文本前缀 阶段三占位 与既有断言一致）
    platformServices: createPlatformServices({ PLATFORM_SERVICES_ENABLED: 'true' }),
    transcriptionJobDelayMs: 30, // 占位 worker 小延迟，便于观察 pending 态
  });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.$disconnect();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

async function uploadAudio(seed: string, content?: Buffer): Promise<string> {
  // 每次生成唯一内容（防 sha256 幂等去重跨用例共享资产/状态互相干扰）
  const body = content ?? Buffer.concat([MP3_ID3, Buffer.from(`-${seed}-${randomBytes(4).toString('hex')}`)]);
  const result = await service.upload({
    teacherId: TEACHER,
    mediaType: 'audio',
    originalFilename: `${seed}.mp3`,
    mimeType: 'audio/mpeg',
    content: body,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`audio 上传失败: ${result.error.message}`);
  return result.value.id;
}

/**
 * P10 t6：platform-services ASR 接线（真实 adapter 路径）——worker 读解密后明文 → asr.transcribe
 * → completed + transcriptionText；失败 failed 可重试；retryable 指数退避重试。
 */
describe('P10：ASR 转写接线（shared/platform-services adapter 替换占位）', () => {
  /** 用指定 service 实例轮询转写状态（DB 权威 + 该实例作业瞬态）。 */
  async function poll(
    pollService: ReturnType<typeof createMediaAssetService>,
    assetId: string,
    expected: string,
    timeoutMs = 4000,
  ): Promise<{ status: string; text: string | null; confidence: number | null; jobStatus: string | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pollResult = await pollService.getTranscription(TEACHER, assetId);
      if (!pollResult.ok) throw new Error(`轮询失败: ${pollResult.error.message}`);
      const { transcriptionStatus, transcriptionText, transcriptionConfidence, job } = pollResult.value;
      if (transcriptionStatus === expected) {
        return { status: transcriptionStatus, text: transcriptionText, confidence: transcriptionConfidence, jobStatus: job?.status ?? null };
      }
      if (Date.now() > deadline) {
        throw new Error(`等待转写状态 ${expected} 超时，当前 ${transcriptionStatus}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }

  it('S3 接线：worker 读解密后明文 → adapter 收到 content+sha256 → 写真实 transcriptionText', async () => {
    const plainAudio = Buffer.concat([MP3_ID3, Buffer.from(`-wiring-${randomBytes(4).toString('hex')}`)]);
    const expectedSha = createHash('sha256').update(plainAudio).digest('hex');
    const captured: { content?: Buffer; sha256?: string; mimeType?: string; assetId?: string } = {};
    const capturingAsr: AsrAdapter = {
      provider: 'test-capture',
      async transcribe(input) {
        captured.content = input.content;
        captured.sha256 = input.sha256;
        captured.mimeType = input.mimeType;
        captured.assetId = input.assetId;
        return { text: '真实转写文本：课堂录音片段', confidence: 0.95 };
      },
    };
    const wiringService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'transc_' }),
      platformServices: { asr: capturingAsr },
    });

    const assetId = await uploadAudio('wiring', plainAudio);
    const submitted = await wiringService.submitTranscription(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await poll(wiringService, assetId, 'completed');
    expect(done.text).toBe('真实转写文本：课堂录音片段');
    expect(done.confidence).toBe(0.95);
    expect(done.jobStatus).toBe('succeeded');

    // adapter 只见解密后明文（= 上传原文）+ 明文 sha256（幂等键）
    expect(captured.content?.equals(plainAudio)).toBe(true);
    expect(captured.sha256).toBe(expectedSha);
    expect(captured.mimeType).toBe('audio/mpeg');
    expect(captured.assetId).toBe(assetId);
  });

  it('非法置信度不会伪装成成功：超出 0..1 → failed 且不落库', async () => {
    const invalidService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'transc_' }),
      platformServices: { asr: { provider: 'test-invalid-confidence', async transcribe() { return { text: 'invalid', confidence: 1.1 }; } } },
    });
    const assetId = await uploadAudio('invalid-confidence');
    const submitted = await invalidService.submitTranscription(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const failed = await poll(invalidService, assetId, 'failed');
    expect(failed.text).toBeNull();
    expect(failed.confidence).toBeNull();
  });

  it('非重试失败（auth）→ transcriptionStatus=failed + 作业 failed；重提交（可用 adapter）→ completed', async () => {
    const failingAsr: AsrAdapter = {
      provider: 'test-auth-fail',
      async transcribe() {
        throw providerError('auth', 401, '平台 ASR 密钥无效');
      },
    };
    const failingService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'transc_' }),
      platformServices: { asr: failingAsr },
    });

    const assetId = await uploadAudio('auth-fail');
    const submitted = await failingService.submitTranscription(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await poll(failingService, assetId, 'failed');
    expect(failed.text).toBeNull();
    expect(failed.jobStatus).toBe('failed');

    // failed → 可重试提交（主 service 占位 adapter 可用）→ completed
    const retry = await service.submitTranscription(TEACHER, assetId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.transcriptionStatus).toBe('pending');
    const done = await waitForTranscriptionStatus(assetId, 'completed');
    expect(done.text).toContain('阶段三占位');
    expect(done.jobStatus).toBe('succeeded');
  });

  it('retryable（rate_limited）→ 指数退避重试后成功（2 次失败 + 第 3 次成功）', async () => {
    let calls = 0;
    const flakyAsr: AsrAdapter = {
      provider: 'test-flaky',
      async transcribe() {
        calls += 1;
        if (calls < 3) throw providerError('rate_limited', 429, '限流', true);
        return { text: '重试后成功转写', confidence: 0.08 };
      },
    };
    const retryService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'transc_' }),
      platformServices: { asr: flakyAsr },
      transcriptionBackoffBaseMs: 5, // 5ms→10ms，测试加速
      transcriptionMaxAttempts: 5,
    });

    const assetId = await uploadAudio('flaky');
    const submitted = await retryService.submitTranscription(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await poll(retryService, assetId, 'completed');
    expect(done.text).toBe('重试后成功转写');
    expect(done.confidence).toBe(0.08);
    expect(done.jobStatus).toBe('succeeded');
    expect(calls).toBe(3); // 2 次限流失败 + 1 次成功
  });

  it('重试耗尽（一直 retryable 失败）→ failed 终态（不无限重试）', async () => {
    let calls = 0;
    const foreverFlakyAsr: AsrAdapter = {
      provider: 'test-forever-flaky',
      async transcribe() {
        calls += 1;
        throw providerError('provider_down', 503, '供应商不可用', true);
      },
    };
    const exhaustedService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'transc_' }),
      platformServices: { asr: foreverFlakyAsr },
      transcriptionBackoffBaseMs: 2, // 测试加速（2ms→4ms→8ms→16ms）
      transcriptionMaxAttempts: 4,
    });

    const assetId = await uploadAudio('exhausted');
    const submitted = await exhaustedService.submitTranscription(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await poll(exhaustedService, assetId, 'failed');
    expect(failed.jobStatus).toBe('failed');
    expect(calls).toBe(4); // 上限 4 次，重试耗尽不再无限重试
  });
});
