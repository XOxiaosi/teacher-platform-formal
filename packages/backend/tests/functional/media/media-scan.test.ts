/**
 * P12 平台预配线 A3/C（t1）功能测试：病毒扫描——上传自动触发/显式提交 → 异步扫描作业
 * （pending → clean|infected|error）→ scanStatus 驱动 + infected 隔离（下载拒绝 + 证据关联拒绝 +
 * 元数据可见）+ 平台预配 scan 门面接线（worker 读解密后明文 → scan.scan → 写 scanStatus/scanThreatName；
 * 非重试失败 → error 可重扫；retryable 指数退避重试；重试耗尽终态）+ owner 隔离。
 *
 * 覆盖：
 * - 基线零破坏：无平台服务/启用门面 scan=none → 上传 scanStatus=skipped，不自动触发；
 * - 上传后自动触发（scan 通道已装配）：上传 → pending → clean（mock adapter）；
 * - 显式提交：skipped → 202 pending → clean；pending 重复提交拒绝；缺 jobs INTERNAL_ERROR；
 * - 占位降级：未配置 scan → submitScan → pending → error（scan 返回 status='error'，不静默放行，不崩服）；
 * - infected 隔离：scanStatus=infected + scanThreatName + 作业 succeeded；readFile 拒绝（PERMISSION_DENIED）；
 *   captureEvidence 拒绝（VALIDATION_ERROR）；getOwned 元数据仍可见（管理端可查看）；路由下载 401；
 *   infected 终态重提交拒绝；
 * - error → 重扫：status='error' → scanStatus=error 可重扫；clean → 重扫合法；
 * - P12 scan 接线：worker 读解密后明文 → adapter（content/sha256/mimeType 断言）→ clean/infected 落库；
 *   auth 失败 → error + 重提交；rate_limited 指数退避重试成功；重试耗尽 error 终态；
 * - owner 隔离：跨教师提交/轮询 → NOT_FOUND；路由跨教师 404。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { createStorage } from '../../../src/shared/storage/index.js';
import { createJobStore } from '../../../src/shared/background-jobs/index.js';
import {
  PLATFORM_SCAN_PROVIDER_ENV,
  PLATFORM_SERVICES_ENABLED_ENV,
  createPlatformServices,
  providerError,
} from '../../../src/shared/platform-services/index.js';
import type { ScanAdapter } from '../../../src/shared/platform-services/index.js';
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

const TEACHER = `teacher_scan_${randomBytes(4).toString('hex')}`;
const TEACHER_OTHER = `teacher_scan_other_${randomBytes(4).toString('hex')}`;
const STUDENT = `student_scan_${randomBytes(4).toString('hex')}`;

let tempRoot: string;
let service: ReturnType<typeof createMediaAssetService>;
let sources: ReturnType<typeof createStudentSourceRecordService>;
let jobs: ReturnType<typeof createJobStore>;

/** 轮询直到扫描状态达成（worker 异步完成；DB 状态为权威）。 */
async function waitForScanStatus(
  pollService: ReturnType<typeof createMediaAssetService>,
  teacherId: string,
  assetId: string,
  expected: string,
  timeoutMs = 4000,
): Promise<{ status: string; threatName: string | null; jobStatus: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const poll = await pollService.getScan(teacherId, assetId);
    if (!poll.ok) throw new Error(`轮询失败: ${poll.error.message}`);
    const { scanStatus, scanThreatName, job } = poll.value;
    if (scanStatus === expected) {
      return { status: scanStatus, threatName: scanThreatName, jobStatus: job?.status ?? null };
    }
    if (Date.now() > deadline) {
      throw new Error(`等待扫描状态 ${expected} 超时，当前 ${scanStatus}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'media-scan-test-'));
  const storage = createStorage({ rootDir: tempRoot });
  sources = createStudentSourceRecordService(prisma);
  jobs = createJobStore({ jobIdPrefix: 'scan_' });
  service = createMediaAssetService({
    getClient: async () => prisma,
    storage,
    sources,
    mediaCipher: cipher,
    jobs,
    // 平台预配门面：启用 + scan=none → services.scan 未实例化（上传保持 skipped；显式提交走占位降级）
    platformServices: createPlatformServices({ PLATFORM_SERVICES_ENABLED: 'true' }),
    scanJobDelayMs: 30,
  });
  await prisma.student.create({
    data: {
      id: STUDENT,
      teacherId: TEACHER,
      name: '扫描测试学生',
      grade: 'grade-1',
      currentStatus: 'active',
      createdAtTs: new Date(),
      updatedAtTs: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER, TEACHER_OTHER] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT } });
  await prisma.$disconnect();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

async function uploadImage(seed: string, content?: Buffer): Promise<string> {
  // 每次生成唯一内容（防 sha256 幂等去重跨用例共享资产/状态互相干扰）
  const body = content ?? Buffer.concat([PNG_MAGIC, Buffer.from(`-scan-${seed}-${randomBytes(4).toString('hex')}`)]);
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

describe('P12 A3/C：扫描作业流转（提交/轮询/状态机/owner 隔离/占位降级）', () => {
  it('上传默认 scanStatus=skipped（无 scan 通道基线）；显式提交未配置 → pending → error 占位降级不崩服', async () => {
    const assetId = await uploadImage('baseline');
    const meta = await service.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.scanStatus).toBe('skipped');
    expect(meta.value.scanThreatName).toBeNull();

    // 未配置 scan（platformServices.scan === undefined）→ 媒体服务占位 fallback：提交 → pending → error
    const submitted = await service.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.jobId).toMatch(/^scan_/);
    expect(submitted.value.scanStatus).toBe('pending');

    const done = await waitForScanStatus(service, TEACHER, assetId, 'error');
    expect(done.threatName).toBeNull();
    expect(done.jobStatus).toBe('failed');
    // 作业错误可辨「平台预配扫描未启用」（不静默放行——绝不伪造 clean）
    const poll = await service.getScan(TEACHER, assetId);
    expect(poll.ok).toBe(true);
    if (poll.ok) expect(poll.value.job?.error).toContain('平台预配病毒扫描');
  });

  it('启用门面 + scan=none → 上传不自动触发（保持 skipped，基线零破坏）', async () => {
    // service 已用 createPlatformServices({ENABLED:true})（scanProvider 缺省 none → scan 未实例化）
    const assetId = await uploadImage('no-autoscan');
    const meta = await service.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.scanStatus).toBe('skipped');
  });

  it('上传后自动触发扫描（scan 通道已装配）：上传 → pending → clean（mock adapter）', async () => {
    const cleanScan: ScanAdapter = {
      provider: 'test-clean',
      async scan() {
        return { status: 'clean' };
      },
    };
    const autoService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: cleanScan },
    });

    // 上传即触发：创建行后 scanStatus → pending（DTO 反映 pending）
    const body = Buffer.concat([PNG_MAGIC, Buffer.from(`-auto-${randomBytes(4).toString('hex')}`)]);
    const result = await autoService.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'auto.png',
      mimeType: 'image/png',
      content: body,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanStatus).toBe('pending');

    const done = await waitForScanStatus(autoService, TEACHER, result.value.id, 'clean');
    expect(done.threatName).toBeNull();
    expect(done.jobStatus).toBe('succeeded');
  });

  it('显式提交 → 202 pending → clean；元数据含 scanStatus/scanThreatName', async () => {
    const cleanScan: ScanAdapter = {
      provider: 'test-clean',
      async scan() {
        return { status: 'clean' };
      },
    };
    const submitService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: cleanScan },
    });
    const assetId = await uploadImage('explicit');
    const submitted = await submitService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.scanStatus).toBe('pending');

    const done = await waitForScanStatus(submitService, TEACHER, assetId, 'clean');
    expect(done.status).toBe('clean');
    expect(done.jobStatus).toBe('succeeded');
    const meta = await submitService.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.scanStatus).toBe('clean');
    expect(meta.value.scanThreatName).toBeNull();
  });

  it('状态机：skipped→infected 非法拒绝；pending 中重复提交 → VALIDATION_ERROR（已在队列）', async () => {
    const assetId = await uploadImage('dup-scan');
    // skipped → infected 直接跳转非法（隔离终态只能由扫描作业驱动）
    const illegal = await service.updateScanStatus(TEACHER, assetId, 'infected');
    expect(illegal.ok).toBe(false);
    if (illegal.ok) return;
    expect(illegal.error.code).toBe('VALIDATION_ERROR');
    expect(illegal.error.message).toContain('非法流转');

    // 慢 worker 服务观察 pending 态：pending 中重复提交拒绝
    const slowService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      scanJobDelayMs: 300,
    });
    const first = await slowService.submitScan(TEACHER, assetId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await slowService.submitScan(TEACHER, assetId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('VALIDATION_ERROR');
    expect(second.error.message).toContain('队列中');

    // 等 slow worker 完成（占位 → error），避免 afterAll 删行竞争
    await waitForScanStatus(slowService, TEACHER, assetId, 'error');
  });

  it('缺 jobs 存储 → INTERNAL_ERROR', async () => {
    const noJobsService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      // 不注入 jobs
    });
    const assetId = await uploadImage('nojobs-scan');
    const res = await noJobsService.submitScan(TEACHER, assetId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INTERNAL_ERROR');
    expect(res.error.message).toContain('jobs');
  });

  it('owner 隔离：跨教师提交/轮询 → NOT_FOUND', async () => {
    const assetId = await uploadImage('scan-owner');
    const otherSubmit = await service.submitScan(TEACHER_OTHER, assetId);
    expect(otherSubmit.ok).toBe(false);
    if (otherSubmit.ok) return;
    expect(otherSubmit.error.code).toBe('NOT_FOUND');

    const otherPoll = await service.getScan(TEACHER_OTHER, assetId);
    expect(otherPoll.ok).toBe(false);
    if (otherPoll.ok) return;
    expect(otherPoll.error.code).toBe('NOT_FOUND');
  });

  it('路由：提交 202 + 轮询 200 + 跨教师 404 契约', async () => {
    const assetId = await uploadImage('route-scan');
    const app = buildApp();

    const submitRes = await request(app)
      .post(`/media/${assetId}/scan`)
      .set('x-teacher-id', TEACHER);
    expect(submitRes.status).toBe(202);
    const submitBody = submitRes.body as { ok: boolean; data: { jobId: string; scanStatus: string } };
    expect(submitBody.ok).toBe(true);
    expect(submitBody.data.scanStatus).toBe('pending');

    // 轮询路由直到终态（占位 → error）
    let status = 'pending';
    const deadline = Date.now() + 3000;
    while (status === 'pending' && Date.now() < deadline) {
      const pollRes = await request(app)
        .get(`/media/${assetId}/scan`)
        .set('x-teacher-id', TEACHER);
      expect(pollRes.status).toBe(200);
      status = (pollRes.body as { data: { scanStatus: string } }).data.scanStatus;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    expect(status).toBe('error');

    const meta = await service.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.scanStatus).toBe('error');

    // 跨教师路由提交 → 404
    const forbidden = await request(app)
      .post(`/media/${assetId}/scan`)
      .set('x-teacher-id', TEACHER_OTHER);
    expect(forbidden.status).toBe(404);
  });
});

/**
 * P12 A3/C：platform-services scan 接线（真实 adapter 路径）——worker 读解密后明文 → scan.scan
 * → clean/infected/error 落库；infected 隔离语义；失败/重试语义。
 */
describe('P12：scan 接线（shared/platform-services adapter 替换占位）', () => {
  it('S3 接线：worker 读解密后明文 → adapter 收到 content+sha256+mimeType → clean 落库', async () => {
    const plainImage = Buffer.concat([PNG_MAGIC, Buffer.from(`-scan-wiring-${randomBytes(4).toString('hex')}`)]);
    const expectedSha = createHash('sha256').update(plainImage).digest('hex');
    const captured: { content?: Buffer; sha256?: string; mimeType?: string; assetId?: string } = {};
    const capturingScan: ScanAdapter = {
      provider: 'test-capture',
      async scan(input) {
        captured.content = input.content;
        captured.sha256 = input.sha256;
        captured.mimeType = input.mimeType;
        captured.assetId = input.assetId;
        return { status: 'clean' };
      },
    };
    const wiringService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: capturingScan },
    });

    const assetId = await uploadImage('wiring', plainImage);
    const submitted = await wiringService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await waitForScanStatus(wiringService, TEACHER, assetId, 'clean');
    expect(done.jobStatus).toBe('succeeded');

    // adapter 只见解密后明文（= 上传原文）+ 明文 sha256（幂等键）
    expect(captured.content?.equals(plainImage)).toBe(true);
    expect(captured.sha256).toBe(expectedSha);
    expect(captured.mimeType).toBe('image/png');
    expect(captured.assetId).toBe(assetId);
  });

  it('infected → scanStatus=infected + scanThreatName + 作业 succeeded；隔离：下载拒绝 + 证据关联拒绝 + 元数据可见 + 终态', async () => {
    const infectedScan: ScanAdapter = {
      provider: 'test-infected',
      async scan() {
        return { status: 'infected', threatName: 'Eicar-Test-Signature' };
      },
    };
    const infectedService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: infectedScan },
    });

    const assetId = await uploadImage('infected');
    const submitted = await infectedService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await waitForScanStatus(infectedService, TEACHER, assetId, 'infected');
    expect(done.threatName).toBe('Eicar-Test-Signature');
    expect(done.jobStatus).toBe('succeeded'); // 扫描已完成（结果为命中）→ 作业 succeeded

    // 元数据标记 infected（管理端可查看——getOwned 仍返回，隔离只拒绝文件本体/证据关联）
    const meta = await infectedService.getOwned(TEACHER, assetId);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.scanStatus).toBe('infected');
    expect(meta.value.scanThreatName).toBe('Eicar-Test-Signature');

    // 隔离①：受控下载拒绝（文件不出现在受控下载）
    const file = await infectedService.readFile(TEACHER, assetId);
    expect(file.ok).toBe(false);
    if (file.ok) return;
    expect(file.error.code).toBe('PERMISSION_DENIED');
    expect(file.error.message).toContain('隔离');

    // 隔离②：证据关联拒绝（infected 拒绝引用为证据源）
    const captured = await infectedService.captureEvidence({ teacherId: TEACHER, assetId, studentId: STUDENT });
    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.error.code).toBe('VALIDATION_ERROR');
    expect(captured.error.message).toContain('不可作为证据源');

    // 隔离终态：infected 不可重扫/重提交
    const resubmit = await infectedService.submitScan(TEACHER, assetId);
    expect(resubmit.ok).toBe(false);
    if (resubmit.ok) return;
    expect(resubmit.error.code).toBe('VALIDATION_ERROR');
    expect(resubmit.error.message).toContain('不可提交');

    // 路由：infected 文件下载 → 401（PERMISSION_DENIED 映射）
    const app = buildApp();
    const downloadRes = await request(app)
      .get(`/media/${assetId}/file`)
      .set('x-teacher-id', TEACHER);
    expect(downloadRes.status).toBe(401);
  });

  it('adapter 返回 status=error（引擎级失败）→ scanStatus=error + 作业 failed；重提交（可用 adapter）→ clean', async () => {
    const errorScan: ScanAdapter = {
      provider: 'test-engine-error',
      async scan() {
        return { status: 'error', message: 'clamd 不可用（连接拒绝）' };
      },
    };
    const errorService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: errorScan },
    });

    const assetId = await uploadImage('engine-error');
    const submitted = await errorService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await waitForScanStatus(errorService, TEACHER, assetId, 'error');
    expect(failed.threatName).toBeNull();
    expect(failed.jobStatus).toBe('failed');
    const poll = await errorService.getScan(TEACHER, assetId);
    expect(poll.ok).toBe(true);
    if (poll.ok) expect(poll.value.job?.error).toContain('clamd 不可用');

    // error → 可重扫：换可用 adapter 重提交 → clean
    const cleanScan: ScanAdapter = {
      provider: 'test-clean',
      async scan() {
        return { status: 'clean' };
      },
    };
    const retryService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: cleanScan },
    });
    const retry = await retryService.submitScan(TEACHER, assetId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.scanStatus).toBe('pending');
    const done = await waitForScanStatus(retryService, TEACHER, assetId, 'clean');
    expect(done.jobStatus).toBe('succeeded');
  });

  it('clean → 重扫合法（clean→pending→clean）', async () => {
    const cleanScan: ScanAdapter = {
      provider: 'test-clean',
      async scan() {
        return { status: 'clean' };
      },
    };
    const rescanService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: cleanScan },
    });
    const assetId = await uploadImage('rescan');
    const first = await rescanService.submitScan(TEACHER, assetId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await waitForScanStatus(rescanService, TEACHER, assetId, 'clean');

    // clean → 重扫合法（设计 §5.2：管理端/运维触发重扫入口）
    const again = await rescanService.submitScan(TEACHER, assetId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.scanStatus).toBe('pending');
    const done = await waitForScanStatus(rescanService, TEACHER, assetId, 'clean');
    expect(done.jobStatus).toBe('succeeded');
  });

  it('非重试失败（auth）→ scanStatus=error + 作业 failed；重提交（可用 adapter）→ clean', async () => {
    const failingScan: ScanAdapter = {
      provider: 'test-auth-fail',
      async scan() {
        throw providerError('auth', 401, '平台扫描凭据无效');
      },
    };
    const failingService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: failingScan },
    });

    const assetId = await uploadImage('scan-auth-fail');
    const submitted = await failingService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await waitForScanStatus(failingService, TEACHER, assetId, 'error');
    expect(failed.threatName).toBeNull();
    expect(failed.jobStatus).toBe('failed');

    // error → 可重扫（主 service 占位 adapter 仍 error；用可用 adapter 验证 recovery）
    const cleanScan: ScanAdapter = {
      provider: 'test-clean',
      async scan() {
        return { status: 'clean' };
      },
    };
    const retryService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: cleanScan },
    });
    const retry = await retryService.submitScan(TEACHER, assetId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const done = await waitForScanStatus(retryService, TEACHER, assetId, 'clean');
    expect(done.jobStatus).toBe('succeeded');
  });

  it('retryable（rate_limited）→ 指数退避重试后成功（2 次失败 + 第 3 次成功）', async () => {
    let calls = 0;
    const flakyScan: ScanAdapter = {
      provider: 'test-flaky',
      async scan() {
        calls += 1;
        if (calls < 3) throw providerError('rate_limited', 429, '扫描限流', true);
        return { status: 'clean' };
      },
    };
    const retryService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: flakyScan },
      scanBackoffBaseMs: 5, // 5ms→10ms，测试加速
      scanMaxAttempts: 5,
    });

    const assetId = await uploadImage('scan-flaky');
    const submitted = await retryService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const done = await waitForScanStatus(retryService, TEACHER, assetId, 'clean');
    expect(done.jobStatus).toBe('succeeded');
    expect(calls).toBe(3); // 2 次限流失败 + 1 次成功
  });

  it('重试耗尽（一直 retryable 失败）→ error 终态（不无限重试）', async () => {
    let calls = 0;
    const foreverFlakyScan: ScanAdapter = {
      provider: 'test-forever-flaky',
      async scan() {
        calls += 1;
        throw providerError('provider_down', 503, '扫描引擎不可用', true);
      },
    };
    const exhaustedService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      platformServices: { scan: foreverFlakyScan },
      scanBackoffBaseMs: 2, // 测试加速（2ms→4ms→8ms→16ms）
      scanMaxAttempts: 4,
    });

    const assetId = await uploadImage('scan-exhausted');
    const submitted = await exhaustedService.submitScan(TEACHER, assetId);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const failed = await waitForScanStatus(exhaustedService, TEACHER, assetId, 'error');
    expect(failed.jobStatus).toBe('failed');
    expect(calls).toBe(4); // 上限 4 次，重试耗尽不再无限重试
  });

  it('占位降级接线：启用 + PLATFORM_SCAN_PROVIDER=clamav → 上传自动触发 → error（不静默放行，不崩服）', async () => {
    const placeholderService = createMediaAssetService({
      getClient: async () => prisma,
      storage: createStorage({ rootDir: tempRoot }),
      sources,
      mediaCipher: cipher,
      jobs: createJobStore({ jobIdPrefix: 'scan_' }),
      // 门面装配：启用 + clamav → 占位 scan adapter（provider=clamav，scan → status=error）
      platformServices: createPlatformServices({
        [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
        [PLATFORM_SCAN_PROVIDER_ENV]: 'clamav',
      }),
    });

    // 上传自动触发 → pending → error（占位不实际扫描，不伪造 clean/infected）
    const body = Buffer.concat([PNG_MAGIC, Buffer.from(`-placeholder-${randomBytes(4).toString('hex')}`)]);
    const result = await placeholderService.upload({
      teacherId: TEACHER,
      mediaType: 'image',
      originalFilename: 'placeholder.png',
      mimeType: 'image/png',
      content: body,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanStatus).toBe('pending');

    const done = await waitForScanStatus(placeholderService, TEACHER, result.value.id, 'error');
    expect(done.jobStatus).toBe('failed');
    const poll = await placeholderService.getScan(TEACHER, result.value.id);
    expect(poll.ok).toBe(true);
    if (poll.ok) {
      expect(poll.value.job?.error).toContain('PLATFORM_SCAN_PROVIDER=clamav');
      expect(poll.value.job?.error).toContain('用户确认后');
    }
  });
});
