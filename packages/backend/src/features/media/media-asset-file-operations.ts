import { createHash } from 'node:crypto';
import {
  err,
  internalError,
  notFound,
  ok,
  permissionDenied,
  validationError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import type { MediaAssetService } from './types.js';
import type { MediaAssetServiceRuntime } from './media-asset-service-runtime.js';
import { runScanJob } from './media-asset-processing-jobs.js';
import {
  DEFAULT_OCR_STATUS,
  DEFAULT_PRIVACY_LEVEL,
  DEFAULT_SCAN_MAX_ATTEMPTS,
  DEFAULT_SCAN_STATUS,
  DEFAULT_SCAN_BACKOFF_BASE_MS,
  DEFAULT_TRANSCRIPTION_STATUS,
  cryptoRandomId,
  toDto,
  validateUpload,
} from './media-asset-service-support.js';
import type { MediaAssetDto } from './types.js';
import type { MediaSourceType } from './media-asset-service-options.js';

export function createMediaAssetFileOperations(runtime: MediaAssetServiceRuntime): Pick<MediaAssetService, 'upload' | 'getOwned' | 'readFile' | 'captureEvidence'> {
  const { options } = runtime;
  const { storage, mediaCipher } = options;

  async function getOwned(teacherId: string, assetId: string): Promise<Result<MediaAssetDto, CommonError>> {
    const { prisma } = await runtime.resolve();
    const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
    return row ? ok(toDto(row)) : err(notFound('媒体资产不存在'));
  }

  return {
    async upload(input) {
      const validated = validateUpload(input);
      if (!validated.ok) return validated;
      if (!mediaCipher) return err(internalError('SAFETY_BLOCK: 缺少 MEDIA_ENCRYPTION_KEY——拒绝媒体明文落盘'));

      const { prisma, trustedClock } = await runtime.resolve();
      const now = await trustedClock.now();
      if (!now.ok) return now;
      const sha256 = createHash('sha256').update(input.content).digest('hex');
      const existing = await prisma.mediaAsset.findFirst({ where: { teacherId: input.teacherId, sha256 } });
      if (existing) return ok(toDto(existing, existing.id));

      const assetId = cryptoRandomId();
      const originalPath = `media/${input.teacherId}/${assetId}/original`;
      const saved = await storage.save({ exactRef: originalPath, filename: 'original', content: mediaCipher.encrypt(input.content) });
      if (!saved.ok) return saved;

      const readBack = await storage.read({ fileRef: originalPath });
      if (!readBack.ok) {
        await storage.delete({ fileRef: originalPath }).catch(() => {});
        return err(internalError('媒体文件写后校验失败（无法读回）'));
      }
      let readBackPlain: Buffer;
      try {
        readBackPlain = mediaCipher.decrypt(readBack.value);
      } catch (error) {
        await storage.delete({ fileRef: originalPath }).catch(() => {});
        return err(internalError(error instanceof Error ? error.message : '媒体文件写后校验失败（解密异常）'));
      }
      if (createHash('sha256').update(readBackPlain).digest('hex') !== sha256) {
        await storage.delete({ fileRef: originalPath }).catch(() => {});
        return err(internalError('媒体文件写后校验失败（sha256 不一致）'));
      }

      const row = await prisma.mediaAsset.create({
        data: {
          id: assetId, teacherId: input.teacherId, mediaType: validated.value.mediaType, sha256,
          mimeType: validated.value.mimeType, sizeBytes: input.content.length, privacyLevel: DEFAULT_PRIVACY_LEVEL,
          scanStatus: DEFAULT_SCAN_STATUS, transcriptionStatus: DEFAULT_TRANSCRIPTION_STATUS, ocrStatus: DEFAULT_OCR_STATUS,
          encryptionVersion: mediaCipher.version, originalPath, createdAtTs: now.value,
        },
      });

      let resultRow = row;
      if (runtime.autoScanEnabled && options.jobs) {
        const jobId = options.jobs.create('media_scan', input.teacherId);
        resultRow = await prisma.mediaAsset.update({
          where: { id: row.id }, data: { scanStatus: 'pending', scanJobId: jobId, scanThreatName: null },
        });
        void runScanJob({
          jobId, assetId: row.id, teacherId: input.teacherId, getClient: options.getClient, jobs: options.jobs,
          storage, mediaCipher, scan: runtime.scan, delayMs: options.scanJobDelayMs ?? 0,
          maxAttempts: options.scanMaxAttempts ?? DEFAULT_SCAN_MAX_ATTEMPTS,
          backoffBaseMs: options.scanBackoffBaseMs ?? DEFAULT_SCAN_BACKOFF_BASE_MS,
        });
      }

      if (input.studentId && options.sources) {
        const captured = await options.sources.captureSource({
          teacherId: input.teacherId, studentId: input.studentId, sourceType: validated.value.mediaType as MediaSourceType,
          sourceEntityType: 'MediaAsset', sourceEntityId: assetId, rawText: '', occurredAt: input.occurredAt ?? now.value,
        });
        if (!captured.ok) return ok(toDto(resultRow));
      }
      return ok(toDto(resultRow));
    },

    async getOwned(teacherId, assetId) {
      return getOwned(teacherId, assetId);
    },

    async readFile(teacherId, assetId) {
      const owned = await getOwned(teacherId, assetId);
      if (!owned.ok) return owned;
      if (owned.value.scanStatus === 'infected') return err(permissionDenied('媒体文件已隔离（scanStatus=infected），不可下载'));
      const file = await storage.read({ fileRef: owned.value.originalPath });
      if (!file.ok) return file;
      try {
        return ok({ row: owned.value, content: mediaCipher ? mediaCipher.decrypt(file.value) : file.value });
      } catch (error) {
        return err(internalError(error instanceof Error ? error.message : '媒体文件解密失败'));
      }
    },

    async captureEvidence(input) {
      if (!options.sources) return err(internalError('证据捕获链未注入'));
      const { prisma, trustedClock } = await runtime.resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: input.assetId, teacherId: input.teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      if (row.scanStatus === 'infected') return err(validationError('媒体资产已隔离（scanStatus=infected），不可作为证据源'));
      const now = await trustedClock.now();
      if (!now.ok) return now;
      const result = await options.sources.captureSource({
        teacherId: input.teacherId, studentId: input.studentId, sourceType: row.mediaType as MediaSourceType,
        sourceEntityType: 'MediaAsset', sourceEntityId: row.id, rawText: '', occurredAt: input.occurredAt ?? now.value,
      });
      return result.ok ? ok({ captured: true }) : result;
    },
  };
}
