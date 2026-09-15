import { Prisma } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
} from '@teacher-platform/contracts';
import { runOcrJob, runScanJob, runTranscriptionJob } from './media-asset-processing-jobs.js';
import type { MediaAssetServiceRuntime } from './media-asset-service-runtime.js';
import {
  DEFAULT_OCR_BACKOFF_BASE_MS,
  DEFAULT_OCR_MAX_ATTEMPTS,
  DEFAULT_SCAN_BACKOFF_BASE_MS,
  DEFAULT_SCAN_MAX_ATTEMPTS,
  DEFAULT_TRANSCRIPTION_BACKOFF_BASE_MS,
  DEFAULT_TRANSCRIPTION_MAX_ATTEMPTS,
  OCR_STATUSES,
  OCR_SUBMITTABLE,
  OCR_TRANSITIONS,
  SCAN_STATUSES,
  SCAN_SUBMITTABLE,
  SCAN_TRANSITIONS,
  TRANSCRIPTION_STATUSES,
  TRANSCRIPTION_SUBMITTABLE,
  TRANSCRIPTION_TRANSITIONS,
  toDto,
} from './media-asset-service-support.js';
import {
  PHASE1_MEDIA_TYPES,
  type MediaAssetService,
  type OcrLayoutBlock,
  type OcrStatus,
  type ScanStatus,
  type TranscriptionStatus,
} from './types.js';

type JobView = { jobId: string; status: string; error: string | null } | null;

function jobView(runtime: MediaAssetServiceRuntime, jobId: string | null): JobView {
  if (!runtime.options.jobs || !jobId) return null;
  const stored = runtime.options.jobs.get(jobId);
  return stored ? { jobId: stored.jobId, status: stored.status, error: stored.error ?? null } : null;
}

export function createMediaAssetProcessingOperations(runtime: MediaAssetServiceRuntime): Pick<
  MediaAssetService,
  'updateTranscriptionStatus' | 'updateScanStatus' | 'submitTranscription' | 'getTranscription' | 'updateOcrStatus' | 'submitOcr' | 'getOcr' | 'submitScan' | 'getScan'
> {
  const { options } = runtime;
  const { storage, mediaCipher } = options;
  return {
    async updateTranscriptionStatus(teacherId, assetId, status) {
      if (!TRANSCRIPTION_STATUSES.includes(status)) return err(validationError(`transcriptionStatus 必须是 ${TRANSCRIPTION_STATUSES.join(' | ')}`, 'transcriptionStatus'));
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.transcriptionStatus as TranscriptionStatus;
      if (!TRANSCRIPTION_TRANSITIONS[current]?.has(status)) return err(validationError(`transcriptionStatus 非法流转：${current} → ${status}`, 'transcriptionStatus'));
      return ok(toDto(await prisma.mediaAsset.update({ where: { id: row.id }, data: { transcriptionStatus: status } })));
    },

    async updateScanStatus(teacherId, assetId, status) {
      if (!SCAN_STATUSES.includes(status)) return err(validationError(`scanStatus 必须是 ${SCAN_STATUSES.join(' | ')}`, 'scanStatus'));
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.scanStatus as ScanStatus;
      if (!SCAN_TRANSITIONS[current]?.has(status)) return err(validationError(`scanStatus 非法流转：${current} → ${status}`, 'scanStatus'));
      return ok(toDto(await prisma.mediaAsset.update({ where: { id: row.id }, data: { scanStatus: status } })));
    },

    async submitTranscription(teacherId, assetId) {
      if (!options.jobs) return err(internalError('转写作业存储未注入（jobs）'));
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      if (row.mediaType !== 'audio') return err(validationError('仅 audio 媒体可提交转写', 'mediaType'));
      const current = row.transcriptionStatus as TranscriptionStatus;
      if (!TRANSCRIPTION_SUBMITTABLE.has(current)) return err(validationError(current === 'pending' ? '转写作业已在队列中（pending）' : `转写状态 ${current} 不可提交（仅 none/failed 可提交）`, 'transcriptionStatus'));
      const jobId = options.jobs.create('media_transcription', teacherId);
      const transitioned = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: { transcriptionStatus: 'pending', transcriptionText: null, transcriptionConfidence: null, transcriptionJobId: jobId },
      });
      void runTranscriptionJob({
        jobId, assetId: row.id, teacherId, getClient: options.getClient, jobs: options.jobs, storage, mediaCipher, asr: runtime.asr,
        delayMs: options.transcriptionJobDelayMs ?? 0, maxAttempts: options.transcriptionMaxAttempts ?? DEFAULT_TRANSCRIPTION_MAX_ATTEMPTS,
        backoffBaseMs: options.transcriptionBackoffBaseMs ?? DEFAULT_TRANSCRIPTION_BACKOFF_BASE_MS,
      });
      return ok({ jobId, assetId: row.id, transcriptionStatus: transitioned.transcriptionStatus });
    },

    async getTranscription(teacherId, assetId) {
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      return ok({ assetId: row.id, transcriptionStatus: row.transcriptionStatus, transcriptionText: row.transcriptionText, transcriptionConfidence: row.transcriptionConfidence, job: jobView(runtime, row.transcriptionJobId) });
    },

    async updateOcrStatus(teacherId, assetId, status) {
      if (!OCR_STATUSES.includes(status)) return err(validationError(`ocrStatus 必须是 ${OCR_STATUSES.join(' | ')}`, 'ocrStatus'));
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.ocrStatus as OcrStatus;
      if (!OCR_TRANSITIONS[current]?.has(status)) return err(validationError(`ocrStatus 非法流转：${current} → ${status}`, 'ocrStatus'));
      return ok(toDto(await prisma.mediaAsset.update({ where: { id: row.id }, data: { ocrStatus: status } })));
    },

    async submitOcr(teacherId, assetId) {
      if (!options.jobs) return err(internalError('OCR 作业存储未注入（jobs）'));
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      if (!PHASE1_MEDIA_TYPES.has(row.mediaType)) return err(validationError('仅 image/screenshot 媒体可提交 OCR', 'mediaType'));
      const current = row.ocrStatus as OcrStatus;
      if (!OCR_SUBMITTABLE.has(current)) return err(validationError(current === 'pending' ? 'OCR 作业已在队列中（pending）' : `OCR 状态 ${current} 不可提交（仅 none/failed 可提交）`, 'ocrStatus'));
      const jobId = options.jobs.create('media_ocr', teacherId);
      const transitioned = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: { ocrStatus: 'pending', ocrText: null, ocrConfidence: null, ocrLayoutBlocks: Prisma.DbNull, ocrJobId: jobId },
      });
      void runOcrJob({
        jobId, assetId: row.id, teacherId, getClient: options.getClient, jobs: options.jobs, storage, mediaCipher, ocr: runtime.ocr,
        delayMs: options.ocrJobDelayMs ?? 0, maxAttempts: options.ocrMaxAttempts ?? DEFAULT_OCR_MAX_ATTEMPTS,
        backoffBaseMs: options.ocrBackoffBaseMs ?? DEFAULT_OCR_BACKOFF_BASE_MS,
      });
      return ok({ jobId, assetId: row.id, ocrStatus: transitioned.ocrStatus });
    },

    async getOcr(teacherId, assetId) {
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      return ok({
        assetId: row.id, ocrStatus: row.ocrStatus, ocrText: row.ocrText, ocrConfidence: row.ocrConfidence,
        ocrLayoutBlocks: (row.ocrLayoutBlocks as OcrLayoutBlock[] | null) ?? null, job: jobView(runtime, row.ocrJobId),
      });
    },

    async submitScan(teacherId, assetId) {
      if (!options.jobs) return err(internalError('扫描作业存储未注入（jobs）'));
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.scanStatus as ScanStatus;
      if (!SCAN_SUBMITTABLE.has(current)) return err(validationError(current === 'pending' ? '扫描作业已在队列中（pending）' : `扫描状态 ${current} 不可提交（仅 skipped/clean/error 可提交；infected 为隔离终态）`, 'scanStatus'));
      const jobId = options.jobs.create('media_scan', teacherId);
      const transitioned = await prisma.mediaAsset.update({
        where: { id: row.id }, data: { scanStatus: 'pending', scanThreatName: null, scanJobId: jobId },
      });
      void runScanJob({
        jobId, assetId: row.id, teacherId, getClient: options.getClient, jobs: options.jobs, storage, mediaCipher, scan: runtime.scan,
        delayMs: options.scanJobDelayMs ?? 0, maxAttempts: options.scanMaxAttempts ?? DEFAULT_SCAN_MAX_ATTEMPTS,
        backoffBaseMs: options.scanBackoffBaseMs ?? DEFAULT_SCAN_BACKOFF_BASE_MS,
      });
      return ok({ jobId, assetId: row.id, scanStatus: transitioned.scanStatus });
    },

    async getScan(teacherId, assetId) {
      const { prisma } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      return ok({ assetId: row.id, scanStatus: row.scanStatus, scanThreatName: row.scanThreatName, job: jobView(runtime, row.scanJobId) });
    },
  };
}
