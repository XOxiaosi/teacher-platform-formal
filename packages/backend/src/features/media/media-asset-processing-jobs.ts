import { Prisma } from '@prisma/client';
import { ProviderError, type AsrAdapter, type OcrAdapter, type ScanAdapter } from '../../shared/platform-services/index.js';
import type { BackgroundJobStore } from '../../shared/background-jobs/index.js';
import type { StorageService } from '../../shared/storage/types.js';
import type { MediaFileCipher } from './media-file-crypto.js';
import type { MediaPrismaClient } from './media-asset-service-options.js';
import { normalizeConfidence } from './media-asset-service-support.js';

interface MediaJobOptions {
  jobId: string;
  assetId: string;
  teacherId: string;
  getClient: () => Promise<MediaPrismaClient>;
  jobs: BackgroundJobStore;
  storage: StorageService;
  mediaCipher?: MediaFileCipher;
  delayMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}

async function readJobContent(options: MediaJobOptions): Promise<
  | { ok: true; prisma: MediaPrismaClient; row: Awaited<ReturnType<MediaPrismaClient['mediaAsset']['findFirst']>> & {} ; content: Buffer }
  | { ok: false; prisma?: MediaPrismaClient; message: string }
> {
  const prisma = await options.getClient();
  const row = await prisma.mediaAsset.findFirst({ where: { id: options.assetId, teacherId: options.teacherId } });
  if (!row) return { ok: false, message: '媒体资产不存在（可能已删除）' };
  const file = await options.storage.read({ fileRef: row.originalPath });
  if (!file.ok) return { ok: false, prisma, message: `读取媒体文件失败：${file.error.message}` };
  try {
    return { ok: true, prisma, row, content: options.mediaCipher ? options.mediaCipher.decrypt(file.value) : file.value };
  } catch (error) {
    return { ok: false, prisma, message: `媒体文件解密失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function isRetryable(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

export async function runTranscriptionJob(options: MediaJobOptions & { asr: AsrAdapter }): Promise<void> {
  const { jobId, assetId, teacherId, jobs } = options;
  try {
    jobs.markRunning(jobId);
    await wait(options.delayMs);
    const loaded = await readJobContent(options);
    if (!loaded.ok) {
      if (loaded.prisma) await failTranscription(loaded.prisma, assetId, teacherId, jobs, jobId, loaded.message);
      else jobs.markFailed(jobId, loaded.message);
      return;
    }
    let lastError = '转写失败';
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const result = await options.asr.transcribe({ assetId, sha256: loaded.row.sha256, content: loaded.content, mimeType: loaded.row.mimeType });
        await loaded.prisma.mediaAsset.update({
          where: { id: assetId, teacherId },
          data: { transcriptionStatus: 'completed', transcriptionText: result.text, transcriptionConfidence: normalizeConfidence(result.confidence) },
        });
        jobs.markSucceeded(jobId, { assetId, transcriptionStatus: 'completed', provider: options.asr.provider });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!isRetryable(error) || attempt >= options.maxAttempts) break;
        await wait(options.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    await failTranscription(loaded.prisma, assetId, teacherId, jobs, jobId, lastError);
  } catch (error) {
    jobs.markFailed(jobId, error instanceof Error ? error.message : String(error));
  }
}

export async function runOcrJob(options: MediaJobOptions & { ocr: OcrAdapter }): Promise<void> {
  const { jobId, assetId, teacherId, jobs } = options;
  try {
    jobs.markRunning(jobId);
    await wait(options.delayMs);
    const loaded = await readJobContent(options);
    if (!loaded.ok) {
      if (loaded.prisma) await failOcr(loaded.prisma, assetId, teacherId, jobs, jobId, loaded.message);
      else jobs.markFailed(jobId, loaded.message);
      return;
    }
    let lastError = 'OCR 识别失败';
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const result = await options.ocr.ocr({ assetId, sha256: loaded.row.sha256, content: loaded.content, mimeType: loaded.row.mimeType });
        await loaded.prisma.mediaAsset.update({
          where: { id: assetId, teacherId },
          data: {
            ocrStatus: 'completed', ocrText: result.text, ocrConfidence: normalizeConfidence(result.confidence),
            ocrLayoutBlocks: result.blocks ? (result.blocks as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          },
        });
        jobs.markSucceeded(jobId, { assetId, ocrStatus: 'completed', provider: options.ocr.provider });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!isRetryable(error) || attempt >= options.maxAttempts) break;
        await wait(options.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    await failOcr(loaded.prisma, assetId, teacherId, jobs, jobId, lastError);
  } catch (error) {
    jobs.markFailed(jobId, error instanceof Error ? error.message : String(error));
  }
}

export async function runScanJob(options: MediaJobOptions & { scan: ScanAdapter }): Promise<void> {
  const { jobId, assetId, teacherId, jobs } = options;
  try {
    jobs.markRunning(jobId);
    await wait(options.delayMs);
    const loaded = await readJobContent(options);
    if (!loaded.ok) {
      if (loaded.prisma) await failScan(loaded.prisma, assetId, teacherId, jobs, jobId, loaded.message);
      else jobs.markFailed(jobId, loaded.message);
      return;
    }
    let lastError = '病毒扫描失败';
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const result = await options.scan.scan({ assetId, sha256: loaded.row.sha256, content: loaded.content, mimeType: loaded.row.mimeType });
        if (result.status === 'clean') {
          await loaded.prisma.mediaAsset.update({ where: { id: assetId, teacherId }, data: { scanStatus: 'clean', scanThreatName: null } });
          jobs.markSucceeded(jobId, { assetId, scanStatus: 'clean', provider: options.scan.provider });
          return;
        }
        if (result.status === 'infected') {
          await loaded.prisma.mediaAsset.update({ where: { id: assetId, teacherId }, data: { scanStatus: 'infected', scanThreatName: result.threatName ?? null } });
          jobs.markSucceeded(jobId, { assetId, scanStatus: 'infected', threatName: result.threatName ?? null, provider: options.scan.provider });
          return;
        }
        lastError = result.message ?? `扫描引擎返回 error（provider=${options.scan.provider}）`;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!isRetryable(error) || attempt >= options.maxAttempts) break;
        await wait(options.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    await failScan(loaded.prisma, assetId, teacherId, jobs, jobId, lastError);
  } catch (error) {
    jobs.markFailed(jobId, error instanceof Error ? error.message : String(error));
  }
}

async function failTranscription(prisma: MediaPrismaClient, assetId: string, teacherId: string, jobs: BackgroundJobStore, jobId: string, message: string): Promise<void> {
  await prisma.mediaAsset.update({ where: { id: assetId, teacherId }, data: { transcriptionStatus: 'failed' } }).catch(() => {});
  jobs.markFailed(jobId, message);
}

async function failOcr(prisma: MediaPrismaClient, assetId: string, teacherId: string, jobs: BackgroundJobStore, jobId: string, message: string): Promise<void> {
  await prisma.mediaAsset.update({ where: { id: assetId, teacherId }, data: { ocrStatus: 'failed' } }).catch(() => {});
  jobs.markFailed(jobId, message);
}

async function failScan(prisma: MediaPrismaClient, assetId: string, teacherId: string, jobs: BackgroundJobStore, jobId: string, message: string): Promise<void> {
  await prisma.mediaAsset.update({ where: { id: assetId, teacherId }, data: { scanStatus: 'error' } }).catch(() => {});
  jobs.markFailed(jobId, message);
}
