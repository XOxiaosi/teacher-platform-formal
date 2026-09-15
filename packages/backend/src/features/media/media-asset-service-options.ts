import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { BackgroundJobStore } from '../../shared/background-jobs/index.js';
import type { PlatformServices } from '../../shared/platform-services/index.js';
import type { StorageService } from '../../shared/storage/types.js';
import type { MediaFileCipher } from './media-file-crypto.js';

export type MediaPrismaClient = PrismaClient | Prisma.TransactionClient;
export type MediaSourceType = 'audio' | 'image' | 'screenshot';

export interface StudentSourceCapturePort {
  captureSource(input: {
    teacherId: string;
    studentId?: string;
    sourceType: MediaSourceType;
    sourceEntityType?: string;
    sourceEntityId?: string;
    rawText: string;
    occurredAt?: Date;
  }): Promise<Result<unknown, CommonError>>;
}

export interface CreateMediaAssetServiceOptions {
  getClient: () => Promise<MediaPrismaClient>;
  storage: StorageService;
  /** 证据捕获链（sourceEntityType=MediaAsset 幂等复用既有 @@unique）。 */
  sources?: StudentSourceCapturePort;
  /** 文件级加密器；缺省时上传拒绝明文落盘。 */
  mediaCipher?: MediaFileCipher;
  /** 异步作业存储；缺省时显式处理任务返回 INTERNAL_ERROR。 */
  jobs?: BackgroundJobStore;
  /** 平台预配的 ASR、OCR、扫描适配器。 */
  platformServices?: PlatformServices;
  transcriptionJobDelayMs?: number;
  transcriptionMaxAttempts?: number;
  transcriptionBackoffBaseMs?: number;
  ocrJobDelayMs?: number;
  ocrMaxAttempts?: number;
  ocrBackoffBaseMs?: number;
  scanJobDelayMs?: number;
  scanMaxAttempts?: number;
  scanBackoffBaseMs?: number;
}
