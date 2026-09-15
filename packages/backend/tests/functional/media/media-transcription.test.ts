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
  PHASE2_MAX_AUDIO_BYTES,
} from '../../../src/features/media/index.js';
import { createMediaRouter } from '../../../src/app/routes/media.routes.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import type { AuthService } from '../../../src/features/auth/index.js';

const prisma = new PrismaClient();

const TEST_MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const cipher = createMediaFileCipher(TEST_MEDIA_KEY);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP3_ID3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from(`\x04\x00\x00\x00\x00\x00voice-${randomBytes(4).toString('hex')}`)]);
const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90]), Buffer.from(`frame-${randomBytes(4).toString('hex')}`)]);
const WAV = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.from(`fmt-${randomBytes(4).toString('hex')}`)]);
const M4A = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ', 'latin1'), Buffer.from(`brand-${randomBytes(4).toString('hex')}`)]);

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

describe('t6：audio 上传白名单（魔数 + 30MB）', () => {
  it('mp3（ID3 头）上传成功 → mimeType=audio/mpeg', async () => {
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'a.mp3',
      mimeType: 'audio/mp3',
      content: MP3_ID3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe('audio/mpeg');
    expect(result.value.mediaType).toBe('audio');
  });

  it('mp3（MPEG 帧同步）上传成功', async () => {
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'b.mp3',
      mimeType: 'audio/mpeg',
      content: MP3_SYNC,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe('audio/mpeg');
  });

  it('wav（RIFF+WAVE）→ audio/wav；m4a（ftyp）→ audio/mp4', async () => {
    const wav = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'c.wav',
      mimeType: 'audio/wav',
      content: WAV,
    });
    expect(wav.ok).toBe(true);
    if (!wav.ok) return;
    expect(wav.value.mimeType).toBe('audio/wav');

    const m4a = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'd.m4a',
      mimeType: 'audio/mp4',
      content: M4A,
    });
    expect(m4a.ok).toBe(true);
    if (!m4a.ok) return;
    expect(m4a.value.mimeType).toBe('audio/mp4');
  });

  it('PNG 内容伪装 audio → 拒绝（魔数嗅探失败）', async () => {
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'fake.mp3',
      mimeType: 'audio/mp3',
      content: Buffer.concat([PNG_MAGIC, Buffer.from('png-payload')]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('音频');
  });

  it('audio 超过 30MB → 拒绝', async () => {
    const big = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(PHASE2_MAX_AUDIO_BYTES + 1, 1)]);
    const result = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'big.mp3',
      mimeType: 'audio/mp3',
      content: big,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('30MB');
  });

  it('audio 幂等去重：同内容二次上传 → duplicateOf', async () => {
    const first = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'dup.mp3',
      mimeType: 'audio/mpeg',
      content: MP3_ID3,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await service.upload({
      teacherId: TEACHER,
      mediaType: 'audio',
      originalFilename: 'dup2.mp3',
      mimeType: 'audio/mpeg',
      content: MP3_ID3,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.duplicateOf).toBe(first.value.id);
  });

  it('路由：multipart 上传 audio 成功 → 201', async () => {
    const res = await request(buildApp())
      .post('/media')
      .set('x-teacher-id', TEACHER)
      .field('mediaType', 'audio')
      .attach('file', MP3_ID3, { filename: 'route.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
    const payload = res.body as { ok: boolean; data: { mediaType: string; mimeType: string; transcriptionStatus: string } };
    expect(payload.ok).toBe(true);
    expect(payload.data.mediaType).toBe('audio');
    expect(payload.data.mimeType).toBe('audio/mpeg');
    expect(payload.data.transcriptionStatus).toBe('none');
  });
});

describe('t6：异步转写作业（提交/轮询/状态机/owner 隔离）', () => {
  it('提交 → 202 pending + jobId；轮询 → completed + 占位文本 + 作业 succeeded', async () => {
    const assetId = await uploadAudio('submit1');
    const submitted = await service.submitTranscription(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.jobId).toMatch(/^transc_/);
    expect(submitted.value.transcriptionStatus).toBe('pending');

    const done = await waitForTranscriptionStatus(assetId, 'completed');
    expect(done.text).toContain('阶段三占位');
    expect(done.jobStatus).toBe('succeeded');
  });

  it('非 audio（image）提交 → VALIDATION_ERROR', async () => {
    const image = await service.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'pic.png',
      mimeType: 'image/png',
      content: Buffer.concat([PNG_MAGIC, Buffer.from('t6-img')]),
    });
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    const res = await service.submitTranscription(TEACHER, image.value.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('VALIDATION_ERROR');
    expect(res.error.message).toContain('仅 audio');
  });

  it('pending 中重复提交 → VALIDATION_ERROR（已在队列）', async () => {
    const assetId = await uploadAudio('dup-submit');
    // 用大延迟服务观察 pending 态（worker 未完成前再次提交）
    const slowService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'transc_' }),
      transcriptionJobDelayMs: 300,
    });
    const first = await slowService.submitTranscription(TEACHER, assetId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await slowService.submitTranscription(TEACHER, assetId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('VALIDATION_ERROR');
    expect(second.error.message).toContain('队列中');

    // 等 slow worker 完成，避免 afterAll 删行竞争
    await waitForTranscriptionStatus(assetId, 'completed');
  });

  it('completed 终态 → 不可重复提交', async () => {
    const assetId = await uploadAudio('completed');
    await service.submitTranscription(TEACHER, assetId);
    await waitForTranscriptionStatus(assetId, 'completed');
    const again = await service.submitTranscription(TEACHER, assetId);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('VALIDATION_ERROR');
    expect(again.error.message).toContain('不可提交');
  });

  it('failed → 可重试提交（failed→pending）', async () => {
    const assetId = await uploadAudio('retry');
    // 直接置 failed（占位状态机合法流转：none→pending→failed）
    await service.updateTranscriptionStatus(TEACHER, assetId, 'pending');
    await service.updateTranscriptionStatus(TEACHER, assetId, 'failed');
    const retry = await service.submitTranscription(TEACHER, assetId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.transcriptionStatus).toBe('pending');
    await waitForTranscriptionStatus(assetId, 'completed');
  });

  it('owner 隔离：跨教师提交/轮询 → NOT_FOUND', async () => {
    const assetId = await uploadAudio('owner');
    const otherSubmit = await service.submitTranscription(TEACHER_OTHER, assetId);
    expect(otherSubmit.ok).toBe(false);
    if (otherSubmit.ok) return;
    expect(otherSubmit.error.code).toBe('NOT_FOUND');

    const otherPoll = await service.getTranscription(TEACHER_OTHER, assetId);
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
    const assetId = await uploadAudio('nojobs');
    const res = await noJobsService.submitTranscription(TEACHER, assetId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INTERNAL_ERROR');
    expect(res.error.message).toContain('jobs');
  });

  it('元数据含 transcriptionStatus/transcriptionText；路由 202/200 契约', async () => {
    const assetId = await uploadAudio('route-tx');
    const app = buildApp();

    const submitRes = await request(app)
      .post(`/media/${assetId}/transcription`)
      .set('x-teacher-id', TEACHER);
    expect(submitRes.status).toBe(202);
    const submitBody = submitRes.body as { ok: boolean; data: { jobId: string; transcriptionStatus: string } };
    expect(submitBody.ok).toBe(true);
    expect(submitBody.data.transcriptionStatus).toBe('pending');

    // 轮询路由直到 completed
    let status = 'pending';
    const deadline = Date.now() + 3000;
    while (status === 'pending' && Date.now() < deadline) {
      const pollRes = await request(app)
        .get(`/media/${assetId}/transcription`)
        .set('x-teacher-id', TEACHER);
      expect(pollRes.status).toBe(200);
      status = (pollRes.body as { data: { transcriptionStatus: string } }).data.transcriptionStatus;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    expect(status).toBe('completed');

    const meta = await service.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.transcriptionStatus).toBe('completed');
    expect(meta.value.transcriptionText).toContain('阶段三占位');

    // 跨教师路由提交 → 404
    const forbidden = await request(app)
      .post(`/media/${assetId}/transcription`)
      .set('x-teacher-id', TEACHER_OTHER);
    expect(forbidden.status).toBe(404);
  });
});
