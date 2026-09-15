import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createPlaceholderAsrAdapter,
  createPlaceholderOcrAdapter,
  createPlaceholderScanAdapter,
  type AsrAdapter,
  type OcrAdapter,
  type ScanAdapter,
} from '../../shared/platform-services/index.js';
import type { CreateMediaAssetServiceOptions, MediaPrismaClient } from './media-asset-service-options.js';

export interface MediaAssetServiceRuntime {
  options: CreateMediaAssetServiceOptions;
  asr: AsrAdapter;
  ocr: OcrAdapter;
  scan: ScanAdapter;
  autoScanEnabled: boolean;
  resolve(): Promise<{ prisma: MediaPrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }>;
}

export function createMediaAssetServiceRuntime(options: CreateMediaAssetServiceOptions): MediaAssetServiceRuntime {
  return {
    options,
    asr: options.platformServices?.asr ?? createPlaceholderAsrAdapter(),
    ocr: options.platformServices?.ocr ?? createPlaceholderOcrAdapter(),
    scan: options.platformServices?.scan ?? createPlaceholderScanAdapter(),
    autoScanEnabled: Boolean(options.platformServices?.scan && options.jobs),
    async resolve() {
      const prisma = await options.getClient();
      return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
    },
  };
}
