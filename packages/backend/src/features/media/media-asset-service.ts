/**
 * 媒体资产服务（P8 S3 多媒体证据链阶段一 · t8 + P9 阶段二 · t3/t6，设计 p7-media-evidence-design.md）。
 *
 * 职责：
 * - 上传：类型/魔数白名单 + 大小上限 + sha256 幂等去重（duplicateOf）+ S1 保守标记；
 *   · 阶段一 image/screenshot（png/jpeg/webp，10MB）；阶段二（t6）audio（mp3/wav/m4a 魔数嗅探，30MB）；
 * - 阶段二加密：原文件 AES-256-GCM 加密落盘（MEDIA_ENCRYPTION_KEY 独立 env，与字段加密 ENCRYPTION_KEY
 *   分轨）；缺密钥拒绝写明文（SAFETY_BLOCK）——阶段一明文静态已知风险关闭（§7.3）；
 * - 受控下载：owner 隔离（teacherId）读取文件本体 → 解密 → 明文仅经服务层输出（不开放静态目录）；
 * - 证据关联：可选自动捕获 StudentSourceRecord（sourceEntityType=MediaAsset，幂等）；
 * - 异步转写作业（t6 + P10 t6）：POST 提交 → transcriptionStatus pending + 内存作业（background-jobs 心智，
 *   owner 隔离）→ worker 读解密后明文 → platform-services asr adapter（未配置=占位降级）→ completed +
 *   transcriptionText；失败 failed 可重试（ProviderError.retryable 指数退避，设计 §6）。真实 ASR 供应商
 *   接入点 = PLATFORM_ASR_PROVIDER env（shared/platform-services 预配线，不进教师配置）。
 * - 异步 OCR 作业（P11 平台预配 A2）：POST 提交 → ocrStatus pending + 内存作业（owner 隔离）→ worker
 *   读解密后明文 → platform-services ocr adapter（未配置=占位降级）→ completed + ocrText/ocrLayoutBlocks；
 *   失败 failed 可重试（ProviderError.retryable 指数退避）。仅 image/screenshot 可提交。真实 OCR 供应商
 *   接入点 = PLATFORM_OCR_PROVIDER env（阶段三-B 替换占位）。
 * - 异步扫描作业（P12 平台预配 A3/C）：上传后自动触发（仅 scan 通道已装配时；未配置保持 skipped 基线零破坏）
 *   或 POST 提交 → scanStatus pending + 内存作业（owner 隔离）→ worker 读解密后明文 → platform-services
 *   scan adapter（未配置=占位降级返回 status='error'，不静默放行）→ clean / infected（隔离终态：
 *   下载拒绝 + 证据关联拒绝 + scanThreatName 落库）/ error（可重扫）。重试：ProviderError.retryable 指数退避。
 *   真实 ClamAV 供应商接入点 = PLATFORM_SCAN_PROVIDER env（阶段三-C 替换占位）。
 *
 * 纪律：
 * - createdAtTs/orphanMarkedAtTs 走 TRUSTED_DB（trustedClock），不引入未登记 new Date；
 * - 文件落盘走 exactRef = media/<teacherId>/<assetId>/original（不入 git 的 .data 存储根）；
 * - 解密/落盘失败一律 err/SAFETY_BLOCK，不静默降级；sha256 恒为明文哈希（幂等键，加密不改指纹语义）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
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
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type { StorageService } from '../../shared/storage/types.js';
import type { BackgroundJobStore } from '../../shared/background-jobs/index.js';
import {
  ProviderError,
  createPlaceholderAsrAdapter,
  createPlaceholderOcrAdapter,
  createPlaceholderScanAdapter,
  type AsrAdapter,
  type OcrAdapter,
  type PlatformServices,
  type ScanAdapter,
} from '../../shared/platform-services/index.js';

import type { MediaFileCipher } from './media-file-crypto.js';
import {
  MEDIA_TYPES,
  OCR_STATUSES,
  OCR_SUBMITTABLE,
  PHASE1_MAX_IMAGE_BYTES,
  PHASE1_MEDIA_TYPES,
  PHASE1_MIME_WHITELIST,
  PHASE2_AUDIO_MIME_WHITELIST,
  PHASE2_MAX_AUDIO_BYTES,
  PHASE2_MEDIA_TYPES,
  SCAN_STATUSES,
  SCAN_SUBMITTABLE,
  TRANSCRIPTION_STATUSES,
  TRANSCRIPTION_SUBMITTABLE,
  type MediaAssetDto,
  type MediaAssetService,
  type MediaUploadInput,
  type OcrLayoutBlock,
  type OcrStatus,
  type ScanStatus,
  type TranscriptionStatus,
} from './types.js';

type MediaPrismaClient = PrismaClient | Prisma.TransactionClient;
type SourceType = 'audio' | 'image' | 'screenshot';

interface StudentSourceCapturePort {
  captureSource(input: {
    teacherId: string;
    studentId?: string;
    sourceType: SourceType;
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
  /**
   * 文件级加密器（阶段二）。缺省（env 未配 MEDIA_ENCRYPTION_KEY）→ 上传写路径拒绝明文落盘
   * （SAFETY_BLOCK）；读路径阶段一明文遗留双读直通。
   */
  mediaCipher?: MediaFileCipher;
  /**
   * 异步作业存储（t6 转写作业；background-jobs 心智：pending/running/succeeded/failed + owner 隔离）。
   * 缺省 → 提交转写返回 INTERNAL_ERROR（装配线注入）。
   */
  jobs?: BackgroundJobStore;
  /**
   * 平台预配服务（P10 t6：shared/platform-services 门面，env 级装配，不进教师配置）。
   * 缺省 → asr 降级为占位 adapter（平台预配未启用时基线行为不变：占位文本 + completed）；
   *         ocr 降级为占位 adapter（P11 A2：占位文本 + 空版面块 + completed）；
   *         scan 降级为占位 adapter（P12 A3/C：scan 返回 status='error'，不静默放行）。
   * 真实 ASR/OCR/扫描供应商接入点在 PLATFORM_ASR_PROVIDER / PLATFORM_OCR_PROVIDER /
   * PLATFORM_SCAN_PROVIDER env（用户确认后替换占位）。
   */
  platformServices?: PlatformServices;
  /** 占位转写 worker 模拟延迟（ms；默认 0=立即异步完成，测试可注入大延迟验证 pending 态）。 */
  transcriptionJobDelayMs?: number;
  /** 转写重试上限（ProviderError.retryable 时指数退避；设计 §6：默认 5 次）。 */
  transcriptionMaxAttempts?: number;
  /** 转写重试退避基数（ms；默认 1000 → 1s/2s/4s/8s；测试可注入小值加速）。 */
  transcriptionBackoffBaseMs?: number;
  /** 占位 OCR worker 模拟延迟（ms；默认 0=立即异步完成，测试可注入大延迟验证 pending 态）。 */
  ocrJobDelayMs?: number;
  /** OCR 重试上限（ProviderError.retryable 时指数退避；设计 §6：默认 5 次）。 */
  ocrMaxAttempts?: number;
  /** OCR 重试退避基数（ms；默认 1000 → 1s/2s/4s/8s；测试可注入小值加速）。 */
  ocrBackoffBaseMs?: number;
  /** 扫描 worker 模拟延迟（ms；默认 0=立即异步完成，测试可注入大延迟验证 pending 态）。 */
  scanJobDelayMs?: number;
  /** 扫描重试上限（ProviderError.retryable 时指数退避；设计 §6：默认 5 次）。 */
  scanMaxAttempts?: number;
  /** 扫描重试退避基数（ms；默认 1000 → 1s/2s/4s/8s；测试可注入小值加速）。 */
  scanBackoffBaseMs?: number;
}

/** 阶段一默认 S1（保守：未成年影像/成绩截图/家庭沟通，PIPL 28 条）。 */
const DEFAULT_PRIVACY_LEVEL = 'S1';
const DEFAULT_SCAN_STATUS = 'skipped';
const DEFAULT_TRANSCRIPTION_STATUS = 'none';
const DEFAULT_OCR_STATUS = 'none';

/** 转写重试默认值（设计 §6：指数退避 1s→2s→4s→8s，上限 5 次）。 */
const DEFAULT_TRANSCRIPTION_MAX_ATTEMPTS = 5;
const DEFAULT_TRANSCRIPTION_BACKOFF_BASE_MS = 1000;

/** OCR 重试默认值（设计 §6：同转写，指数退避 1s→2s→4s→8s，上限 5 次）。 */
const DEFAULT_OCR_MAX_ATTEMPTS = 5;
const DEFAULT_OCR_BACKOFF_BASE_MS = 1000;

/** 扫描重试默认值（设计 §6：同转写/OCR，指数退避 1s→2s→4s→8s，上限 5 次）。 */
const DEFAULT_SCAN_MAX_ATTEMPTS = 5;
const DEFAULT_SCAN_BACKOFF_BASE_MS = 1000;

/**
 * 转写状态机（阶段二占位流转；阶段三真实 ASR 驱动）。
 * none → pending → completed | failed；pending → pending 允许（重试）。
 */
const TRANSCRIPTION_TRANSITIONS: Record<TranscriptionStatus, ReadonlySet<TranscriptionStatus>> = {
  none: new Set(['pending']),
  pending: new Set(['pending', 'completed', 'failed']),
  completed: new Set([]),
  failed: new Set(['pending']), // 失败后可重试
};

/**
 * OCR 状态机（P11 平台预配 A2 占位流转；阶段三-B 真实 OCR 驱动）。
 * none → pending → completed | failed；pending → pending 允许（重试）。
 */
const OCR_TRANSITIONS: Record<OcrStatus, ReadonlySet<OcrStatus>> = {
  none: new Set(['pending']),
  pending: new Set(['pending', 'completed', 'failed']),
  completed: new Set([]),
  failed: new Set(['pending']), // 失败后可重试
};

/**
 * 扫描状态机（阶段二占位流转；阶段三真实病毒扫描驱动）。
 * skipped → pending（阶段一遗留资产进入扫描）；pending → clean | infected | error；pending 可重扫。
 */
const SCAN_TRANSITIONS: Record<ScanStatus, ReadonlySet<ScanStatus>> = {
  pending: new Set(['pending', 'clean', 'infected', 'error']),
  clean: new Set(['pending']), // 重扫
  infected: new Set([]), // 隔离终态（人工复核删除）
  error: new Set(['pending']), // 重试
  skipped: new Set(['pending']),
};

function sniffMimeType(content: Buffer): string | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    content.length >= 12
    && content.subarray(0, 4).toString('latin1') === 'RIFF'
    && content.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** audio 魔数嗅探（t6，design §4.2-1）：mp3（ID3 或 MPEG 帧同步）/ wav（RIFF+WAVE）/ m4a（ftyp 品牌）。 */
function sniffAudioMimeType(content: Buffer): string | null {
  if (content.length >= 3 && content.subarray(0, 3).toString('latin1') === 'ID3') {
    return 'audio/mpeg'; // ID3v2 头
  }
  if (content.length >= 2 && content[0] === 0xff && (content[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg'; // MPEG 音频帧同步字
  }
  if (
    content.length >= 12
    && content.subarray(0, 4).toString('latin1') === 'RIFF'
    && content.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (content.length >= 12 && content.subarray(4, 8).toString('latin1') === 'ftyp') {
    return 'audio/mp4'; // ISO BMFF（m4a/mp4 家族，品牌在 8..12 校验）
  }
  return null;
}

function toDto(row: {
  id: string;
  teacherId: string;
  mediaType: string;
  sha256: string;
  duplicateOf: string | null;
  mimeType: string;
  sizeBytes: number;
  privacyLevel: string;
  scanStatus: string;
  transcriptionStatus: string;
  transcriptionText: string | null;
  ocrStatus: string;
  ocrText: string | null;
  ocrLayoutBlocks: unknown;
  scanJobId: string | null;
  scanThreatName: string | null;
  encryptionVersion: string | null;
  orphanStatus: string;
  orphanMarkedAtTs: Date | null;
  originalPath: string;
  createdAtTs: Date;
}, duplicateOfOverride?: string | null): MediaAssetDto {
  return {
    id: row.id,
    teacherId: row.teacherId,
    mediaType: row.mediaType,
    sha256: row.sha256,
    duplicateOf: duplicateOfOverride !== undefined ? duplicateOfOverride : row.duplicateOf,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    privacyLevel: row.privacyLevel,
    scanStatus: row.scanStatus,
    transcriptionStatus: row.transcriptionStatus,
    transcriptionText: row.transcriptionText,
    ocrStatus: row.ocrStatus,
    ocrText: row.ocrText,
    ocrLayoutBlocks: (row.ocrLayoutBlocks as OcrLayoutBlock[] | null) ?? null,
    scanJobId: row.scanJobId,
    scanThreatName: row.scanThreatName,
    encryptionVersion: row.encryptionVersion,
    orphanStatus: row.orphanStatus,
    orphanMarkedAtTs: row.orphanMarkedAtTs ? row.orphanMarkedAtTs.toISOString() : null,
    originalPath: row.originalPath,
    createdAtTs: row.createdAtTs.toISOString(),
  };
}

export function createMediaAssetService(options: CreateMediaAssetServiceOptions): MediaAssetService {
  const { storage, mediaCipher } = options;
  // P10 t6：平台预配 ASR adapter——未注入/未配置 → 占位降级（基线行为不变：占位文本 + completed）
  const asr: AsrAdapter = options.platformServices?.asr ?? createPlaceholderAsrAdapter();
  // P11 A2：平台预配 OCR adapter——未注入/未配置 → 占位降级（占位文本 + 空版面块 + completed）
  const ocr: OcrAdapter = options.platformServices?.ocr ?? createPlaceholderOcrAdapter();
  // P12 A3/C：平台预配 scan adapter——未注入/未配置 → 占位降级（scan 返回 status='error'，不静默放行；
  // 上传自动触发仅发生在 platformServices.scan 已装配（PLATFORM_SCAN_PROVIDER != none）时，见 upload）
  const scan: ScanAdapter = options.platformServices?.scan ?? createPlaceholderScanAdapter();

  async function resolve(): Promise<{ prisma: MediaPrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await options.getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  async function getOwned(teacherId: string, assetId: string): Promise<Result<MediaAssetDto, CommonError>> {
    const { prisma } = await resolve();
    const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
    return row ? ok(toDto(row)) : err(notFound('媒体资产不存在'));
  }

  function validateUpload(input: MediaUploadInput): Result<{ mediaType: string; mimeType: string }, CommonError> {
    if (!MEDIA_TYPES.includes(input.mediaType as (typeof MEDIA_TYPES)[number])) {
      return err(validationError('mediaType 必须是 image | screenshot | audio | document', 'mediaType'));
    }
    if (input.content.length === 0) {
      return err(validationError('文件不能为空', 'file'));
    }
    if (PHASE2_MEDIA_TYPES.has(input.mediaType)) {
      // 阶段二（t6）：audio——mp3/wav/m4a 魔数嗅探 + 30MB 上限
      const sniffed = sniffAudioMimeType(input.content);
      if (!sniffed) {
        return err(validationError('文件内容不是支持的音频格式（MP3/WAV/M4A 魔数校验失败）', 'file'));
      }
      if (!PHASE2_AUDIO_MIME_WHITELIST.has(sniffed)) {
        return err(validationError(`不支持的文件类型（嗅探为 ${sniffed}）`, 'file'));
      }
      if (input.content.length > PHASE2_MAX_AUDIO_BYTES) {
        return err(validationError(`音频超过大小上限 ${PHASE2_MAX_AUDIO_BYTES / 1024 / 1024}MB`, 'file'));
      }
      return ok({ mediaType: input.mediaType, mimeType: sniffed });
    }
    if (!PHASE1_MEDIA_TYPES.has(input.mediaType)) {
      return err(validationError(`mediaType=${input.mediaType} 阶段未启用（仅 image/screenshot/audio）`, 'mediaType'));
    }
    const sniffed = sniffMimeType(input.content);
    if (!sniffed) {
      return err(validationError('文件内容不是支持的图片格式（PNG/JPEG/WebP 魔数校验失败）', 'file'));
    }
    if (!PHASE1_MIME_WHITELIST.has(sniffed)) {
      return err(validationError(`不支持的文件类型（嗅探为 ${sniffed}）`, 'file'));
    }
    if (input.content.length > PHASE1_MAX_IMAGE_BYTES) {
      return err(validationError(`图片超过大小上限 ${PHASE1_MAX_IMAGE_BYTES / 1024 / 1024}MB`, 'file'));
    }
    return ok({ mediaType: input.mediaType, mimeType: sniffed });
  }

  return {
    async upload(input) {
      const validated = validateUpload(input);
      if (!validated.ok) return validated;

      // 阶段二加密红线：缺 MEDIA_ENCRYPTION_KEY 拒绝写明文（阶段一明文静态风险关闭）
      if (!mediaCipher) {
        return err(internalError('SAFETY_BLOCK: 缺少 MEDIA_ENCRYPTION_KEY——拒绝媒体明文落盘'));
      }

      const { prisma, trustedClock } = await resolve();
      const now = await trustedClock.now();
      if (!now.ok) return now;

      // sha256 恒为明文哈希（幂等去重键；加密不改指纹语义，见设计 §5.1 contentHash）
      const sha256 = createHash('sha256').update(input.content).digest('hex');

      // 幂等去重：同教师同 sha256 已有资产 → 返回已有（不重复落盘/建行）
      const existing = await prisma.mediaAsset.findFirst({
        where: { teacherId: input.teacherId, sha256 },
      });
      if (existing) {
        return ok(toDto(existing, existing.id));
      }

      const assetId = cryptoRandomId();
      const originalPath = `media/${input.teacherId}/${assetId}/original`;
      // 加密后落盘：明文永不经磁盘（密文文件 = enc 头 + iv + tag + cipher）
      const ciphertext = mediaCipher.encrypt(input.content);
      const saved = await storage.save({
        exactRef: originalPath,
        filename: 'original',
        content: ciphertext,
      });
      if (!saved.ok) return saved;

      // 写后校验：读回密文 → 解密 → 明文哈希比对（防写坏/防加密层错误）
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
      const readBackHash = createHash('sha256').update(readBackPlain).digest('hex');
      if (readBackHash !== sha256) {
        await storage.delete({ fileRef: originalPath }).catch(() => {});
        return err(internalError('媒体文件写后校验失败（sha256 不一致）'));
      }

      const row = await prisma.mediaAsset.create({
        data: {
          id: assetId,
          teacherId: input.teacherId,
          mediaType: validated.value.mediaType,
          sha256,
          mimeType: validated.value.mimeType,
          sizeBytes: input.content.length,
          privacyLevel: DEFAULT_PRIVACY_LEVEL,
          scanStatus: DEFAULT_SCAN_STATUS,
          transcriptionStatus: DEFAULT_TRANSCRIPTION_STATUS,
          ocrStatus: DEFAULT_OCR_STATUS,
          encryptionVersion: mediaCipher.version,
          originalPath,
          createdAtTs: now.value,
        },
      });

      // P12 A3/C：上传后自动触发病毒扫描（异步内存作业，上传响应不阻塞——设计 §5.3 D8）。
      // 仅平台扫描通道已装配（PLATFORM_SCAN_PROVIDER != none）时触发；未配置（缺省）→ 保持 skipped
      // 基线零破坏。缺 jobs 存储 → 跳过自动触发（上传不因扫描失败；显式 submitScan 仍可补扫）。
      let resultRow = row;
      if (options.platformServices?.scan && options.jobs) {
        const jobId = options.jobs.create('media_scan', input.teacherId);
        resultRow = await prisma.mediaAsset.update({
          where: { id: row.id },
          data: { scanStatus: 'pending', scanJobId: jobId, scanThreatName: null },
        });
        void runScanJob({
          jobId,
          assetId: row.id,
          teacherId: input.teacherId,
          getClient: options.getClient,
          jobs: options.jobs,
          storage,
          mediaCipher,
          scan,
          delayMs: options.scanJobDelayMs ?? 0,
          maxAttempts: options.scanMaxAttempts ?? DEFAULT_SCAN_MAX_ATTEMPTS,
          backoffBaseMs: options.scanBackoffBaseMs ?? DEFAULT_SCAN_BACKOFF_BASE_MS,
        });
      }

      // 可选证据关联：已识别学生 → 自动捕获 StudentSourceRecord（幂等）
      if (input.studentId && options.sources) {
        const captured = await options.sources.captureSource({
          teacherId: input.teacherId,
          studentId: input.studentId,
          sourceType: validated.value.mediaType as SourceType,
          sourceEntityType: 'MediaAsset',
          sourceEntityId: assetId,
          rawText: '',
          occurredAt: input.occurredAt ?? now.value,
        });
        if (!captured.ok) {
          // 捕获失败不阻断上传（媒体已入档；证据关联可稍后重试）
          return ok(toDto(resultRow));
        }
      }

      return ok(toDto(resultRow));
    },

    async getOwned(teacherId, assetId) {
      return getOwned(teacherId, assetId);
    },

    async readFile(teacherId, assetId) {
      const owned = await getOwned(teacherId, assetId);
      if (!owned.ok) return owned;
      // P12 A3/C infected 隔离：隔离资产不出现在受控下载（元数据仍可查——管理端可查看，文件本体拒绝）
      if (owned.value.scanStatus === 'infected') {
        return err(permissionDenied('媒体文件已隔离（scanStatus=infected），不可下载'));
      }
      const file = await storage.read({ fileRef: owned.value.originalPath });
      if (!file.ok) return file;
      let plaintext: Buffer;
      try {
        // 解密输出明文（仅服务层）；阶段一明文遗留（无密文头）双读直通
        plaintext = mediaCipher ? mediaCipher.decrypt(file.value) : file.value;
      } catch (error) {
        return err(internalError(error instanceof Error ? error.message : '媒体文件解密失败'));
      }
      return ok({ row: owned.value, content: plaintext });
    },

    async captureEvidence(input) {
      if (!options.sources) {
        return err(internalError('证据捕获链未注入'));
      }
      const { prisma, trustedClock } = await resolve();
      const row = await prisma.mediaAsset.findFirst({
        where: { id: input.assetId, teacherId: input.teacherId },
      });
      if (!row) return err(notFound('媒体资产不存在'));
      // P12 A3/C infected 隔离：隔离资产不参与证据链（拒绝引用为证据源）
      if (row.scanStatus === 'infected') {
        return err(validationError('媒体资产已隔离（scanStatus=infected），不可作为证据源'));
      }
      const now = await trustedClock.now();
      if (!now.ok) return now;
      const result = await options.sources.captureSource({
        teacherId: input.teacherId,
        studentId: input.studentId,
        sourceType: row.mediaType as SourceType,
        sourceEntityType: 'MediaAsset',
        sourceEntityId: row.id,
        rawText: '',
        occurredAt: input.occurredAt ?? now.value,
      });
      return result.ok ? ok({ captured: true }) : result;
    },

    async updateTranscriptionStatus(teacherId, assetId, status) {
      // 阶段二占位：仅状态机校验 + 落库；真实 ASR 阶段三 shared/platform-services 接入
      // （见 reports/architecture/p7-media-phase2-platform-services-assessment.md）
      if (!TRANSCRIPTION_STATUSES.includes(status)) {
        return err(validationError(`transcriptionStatus 必须是 ${TRANSCRIPTION_STATUSES.join(' | ')}`, 'transcriptionStatus'));
      }
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.transcriptionStatus as TranscriptionStatus;
      if (!TRANSCRIPTION_TRANSITIONS[current]?.has(status)) {
        return err(validationError(`transcriptionStatus 非法流转：${current} → ${status}`, 'transcriptionStatus'));
      }
      const updated = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: { transcriptionStatus: status },
      });
      return ok(toDto(updated));
    },

    async updateScanStatus(teacherId, assetId, status) {
      // 阶段二占位：仅状态机校验 + 落库；真实病毒扫描阶段三接入
      if (!SCAN_STATUSES.includes(status)) {
        return err(validationError(`scanStatus 必须是 ${SCAN_STATUSES.join(' | ')}`, 'scanStatus'));
      }
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.scanStatus as ScanStatus;
      if (!SCAN_TRANSITIONS[current]?.has(status)) {
        return err(validationError(`scanStatus 非法流转：${current} → ${status}`, 'scanStatus'));
      }
      const updated = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: { scanStatus: status },
      });
      return ok(toDto(updated));
    },

    async submitTranscription(teacherId, assetId) {
      // t6：异步转写作业提交（占位；真实 ASR = 阶段三 shared/platform-services 预配线）
      if (!options.jobs) {
        return err(internalError('转写作业存储未注入（jobs）'));
      }
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));

      if (row.mediaType !== 'audio') {
        return err(validationError('仅 audio 媒体可提交转写', 'mediaType'));
      }
      const current = row.transcriptionStatus as TranscriptionStatus;
      if (!TRANSCRIPTION_SUBMITTABLE.has(current)) {
        return err(validationError(
          current === 'pending' ? '转写作业已在队列中（pending）' : `转写状态 ${current} 不可提交（仅 none/failed 可提交）`,
          'transcriptionStatus',
        ));
      }

      // 内存作业（background-jobs 心智）：owner=teacherId 隔离，防跨教师轮询
      const jobId = options.jobs.create('media_transcription', teacherId);

      // 状态机落库：none|failed → pending（复用合法流转校验）+ 清旧结果 + 挂新 jobId
      const transitioned = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: {
          transcriptionStatus: 'pending',
          transcriptionText: null,
          transcriptionJobId: jobId,
        },
      });

      // 异步转写作业（P10 t6）：占位→真实 ASR 路径——worker 读解密后明文 → asr.transcribe
      // （未配置时 asr=占位 adapter 返回占位文本；DB 状态为权威，内存作业为瞬态进度）
      void runTranscriptionJob({
        jobId,
        assetId: row.id,
        teacherId,
        getClient: options.getClient,
        jobs: options.jobs,
        storage,
        mediaCipher,
        asr,
        delayMs: options.transcriptionJobDelayMs ?? 0,
        maxAttempts: options.transcriptionMaxAttempts ?? DEFAULT_TRANSCRIPTION_MAX_ATTEMPTS,
        backoffBaseMs: options.transcriptionBackoffBaseMs ?? DEFAULT_TRANSCRIPTION_BACKOFF_BASE_MS,
      });

      return ok({ jobId, assetId: row.id, transcriptionStatus: transitioned.transcriptionStatus });
    },

    async getTranscription(teacherId, assetId) {
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      // 内存作业（瞬态，重启即清）；DB transcriptionStatus 为权威状态
      let job: { jobId: string; status: string; error: string | null } | null = null;
      if (options.jobs && row.transcriptionJobId) {
        const stored = options.jobs.get(row.transcriptionJobId);
        if (stored) {
          job = { jobId: stored.jobId, status: stored.status, error: stored.error ?? null };
        }
      }
      return ok({
        assetId: row.id,
        transcriptionStatus: row.transcriptionStatus,
        transcriptionText: row.transcriptionText,
        job,
      });
    },

    async updateOcrStatus(teacherId, assetId, status) {
      // P11 A2 占位：仅状态机校验 + 落库；真实 OCR 阶段三-B shared/platform-services 接入
      if (!OCR_STATUSES.includes(status)) {
        return err(validationError(`ocrStatus 必须是 ${OCR_STATUSES.join(' | ')}`, 'ocrStatus'));
      }
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      const current = row.ocrStatus as OcrStatus;
      if (!OCR_TRANSITIONS[current]?.has(status)) {
        return err(validationError(`ocrStatus 非法流转：${current} → ${status}`, 'ocrStatus'));
      }
      const updated = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: { ocrStatus: status },
      });
      return ok(toDto(updated));
    },

    async submitOcr(teacherId, assetId) {
      // P11 A2：异步 OCR 作业提交（占位；真实 OCR = 阶段三-B shared/platform-services 预配线）
      if (!options.jobs) {
        return err(internalError('OCR 作业存储未注入（jobs）'));
      }
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));

      // 仅 image 类（image/screenshot；阶段一图片白名单）可提交 OCR
      if (!PHASE1_MEDIA_TYPES.has(row.mediaType)) {
        return err(validationError('仅 image/screenshot 媒体可提交 OCR', 'mediaType'));
      }
      const current = row.ocrStatus as OcrStatus;
      if (!OCR_SUBMITTABLE.has(current)) {
        return err(validationError(
          current === 'pending' ? 'OCR 作业已在队列中（pending）' : `OCR 状态 ${current} 不可提交（仅 none/failed 可提交）`,
          'ocrStatus',
        ));
      }

      // 内存作业（background-jobs 心智）：owner=teacherId 隔离，防跨教师轮询
      const jobId = options.jobs.create('media_ocr', teacherId);

      // 状态机落库：none|failed → pending（复用合法流转校验）+ 清旧结果 + 挂新 jobId
      const transitioned = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: {
          ocrStatus: 'pending',
          ocrText: null,
          ocrLayoutBlocks: Prisma.DbNull,
          ocrJobId: jobId,
        },
      });

      // 异步 OCR 作业（P11 A2）：占位→真实 OCR 路径——worker 读解密后明文 → ocr.ocr
      // （未配置时 ocr=占位 adapter 返回占位文本 + 空版面块；DB 状态为权威，内存作业为瞬态进度）
      void runOcrJob({
        jobId,
        assetId: row.id,
        teacherId,
        getClient: options.getClient,
        jobs: options.jobs,
        storage,
        mediaCipher,
        ocr,
        delayMs: options.ocrJobDelayMs ?? 0,
        maxAttempts: options.ocrMaxAttempts ?? DEFAULT_OCR_MAX_ATTEMPTS,
        backoffBaseMs: options.ocrBackoffBaseMs ?? DEFAULT_OCR_BACKOFF_BASE_MS,
      });

      return ok({ jobId, assetId: row.id, ocrStatus: transitioned.ocrStatus });
    },

    async getOcr(teacherId, assetId) {
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      // 内存作业（瞬态，重启即清）；DB ocrStatus 为权威状态
      let job: { jobId: string; status: string; error: string | null } | null = null;
      if (options.jobs && row.ocrJobId) {
        const stored = options.jobs.get(row.ocrJobId);
        if (stored) {
          job = { jobId: stored.jobId, status: stored.status, error: stored.error ?? null };
        }
      }
      return ok({
        assetId: row.id,
        ocrStatus: row.ocrStatus,
        ocrText: row.ocrText,
        ocrLayoutBlocks: (row.ocrLayoutBlocks as OcrLayoutBlock[] | null) ?? null,
        job,
      });
    },

    async submitScan(teacherId, assetId) {
      // P12 A3/C：异步病毒扫描作业提交（占位→真实 ClamAV = 阶段三-C shared/platform-services 预配线）
      if (!options.jobs) {
        return err(internalError('扫描作业存储未注入（jobs）'));
      }
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));

      const current = row.scanStatus as ScanStatus;
      if (!SCAN_SUBMITTABLE.has(current)) {
        return err(validationError(
          current === 'pending' ? '扫描作业已在队列中（pending）' : `扫描状态 ${current} 不可提交（仅 skipped/clean/error 可提交；infected 为隔离终态）`,
          'scanStatus',
        ));
      }

      // 内存作业（background-jobs 心智）：owner=teacherId 隔离，防跨教师轮询
      const jobId = options.jobs.create('media_scan', teacherId);

      // 状态机落库：skipped|clean|error → pending（复用合法流转校验）+ 清旧威胁名 + 挂新 jobId
      const transitioned = await prisma.mediaAsset.update({
        where: { id: row.id },
        data: {
          scanStatus: 'pending',
          scanThreatName: null,
          scanJobId: jobId,
        },
      });

      // 异步扫描作业（P12 A3/C）：worker 读解密后明文 → scan.scan
      // （未配置时 scan=占位 adapter 返回 status='error' → scanStatus=error 可重扫，不崩服；
      //   DB 状态为权威，内存作业为瞬态进度）
      void runScanJob({
        jobId,
        assetId: row.id,
        teacherId,
        getClient: options.getClient,
        jobs: options.jobs,
        storage,
        mediaCipher,
        scan,
        delayMs: options.scanJobDelayMs ?? 0,
        maxAttempts: options.scanMaxAttempts ?? DEFAULT_SCAN_MAX_ATTEMPTS,
        backoffBaseMs: options.scanBackoffBaseMs ?? DEFAULT_SCAN_BACKOFF_BASE_MS,
      });

      return ok({ jobId, assetId: row.id, scanStatus: transitioned.scanStatus });
    },

    async getScan(teacherId, assetId) {
      const { prisma } = await resolve();
      const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
      if (!row) return err(notFound('媒体资产不存在'));
      // 内存作业（瞬态，重启即清）；DB scanStatus 为权威状态
      let job: { jobId: string; status: string; error: string | null } | null = null;
      if (options.jobs && row.scanJobId) {
        const stored = options.jobs.get(row.scanJobId);
        if (stored) {
          job = { jobId: stored.jobId, status: stored.status, error: stored.error ?? null };
        }
      }
      return ok({
        assetId: row.id,
        scanStatus: row.scanStatus,
        scanThreatName: row.scanThreatName,
        job,
      });
    },
  };
}

/**
 * 转写作业 worker（P10 t6）：markRunning → 读解密后明文 → asr.transcribe →
 * 成功 completed + transcriptionText（写 DB，权威）；失败 failed（可重试，TRANSCRIPTION_SUBMITTABLE 含 failed）。
 * 重试：ProviderError.retryable=true 时指数退避（backoffBaseMs×2^(n-1)，上限 maxAttempts）；非重试错误快速失败。
 * 真实 ASR 供应商接入点 = PLATFORM_ASR_PROVIDER env（用户确认后替换占位 adapter，本 worker 契约不变）。
 */
async function runTranscriptionJob(options: {
  jobId: string;
  assetId: string;
  teacherId: string;
  getClient: () => Promise<MediaPrismaClient>;
  jobs: BackgroundJobStore;
  storage: StorageService;
  mediaCipher?: MediaFileCipher;
  asr: AsrAdapter;
  delayMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}): Promise<void> {
  const { jobId, assetId, teacherId, jobs } = options;
  try {
    jobs.markRunning(jobId);
    if (options.delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
    }
    const prisma = await options.getClient();
    const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
    if (!row) {
      jobs.markFailed(jobId, '媒体资产不存在（可能已删除）');
      return;
    }

    // adapter 只见解密后明文 Buffer（存储层读密文 → 服务层解密；密钥不出媒体服务）
    const file = await options.storage.read({ fileRef: row.originalPath });
    if (!file.ok) {
      await failTranscription(prisma, assetId, teacherId, jobs, jobId, `读取媒体文件失败：${file.error.message}`);
      return;
    }
    let content: Buffer;
    try {
      content = options.mediaCipher ? options.mediaCipher.decrypt(file.value) : file.value;
    } catch (error) {
      await failTranscription(
        prisma,
        assetId,
        teacherId,
        jobs,
        jobId,
        `媒体文件解密失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    let lastError = '转写失败';
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const result = await options.asr.transcribe({
          assetId,
          sha256: row.sha256,
          content,
          mimeType: row.mimeType,
        });
        await prisma.mediaAsset.update({
          where: { id: assetId, teacherId },
          data: {
            transcriptionStatus: 'completed',
            transcriptionText: result.text,
          },
        });
        jobs.markSucceeded(jobId, { assetId, transcriptionStatus: 'completed', provider: options.asr.provider });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // 只对 ProviderError.retryable 重试（指数退避）；其他异常快速失败，不烧重试次数
        const retryable = error instanceof ProviderError ? error.retryable : false;
        if (!retryable || attempt >= options.maxAttempts) break;
        const backoffMs = options.backoffBaseMs * 2 ** (attempt - 1);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, backoffMs));
      }
    }
    await failTranscription(prisma, assetId, teacherId, jobs, jobId, lastError);
  } catch (error) {
    jobs.markFailed(jobId, error instanceof Error ? error.message : String(error));
  }
}

/** 置 failed（DB 权威）→ 作业 failed；DB 更新失败不阻断作业失败标记。 */
async function failTranscription(
  prisma: MediaPrismaClient,
  assetId: string,
  teacherId: string,
  jobs: BackgroundJobStore,
  jobId: string,
  message: string,
): Promise<void> {
  await prisma.mediaAsset
    .update({
      where: { id: assetId, teacherId },
      data: { transcriptionStatus: 'failed' },
    })
    .catch(() => {});
  jobs.markFailed(jobId, message);
}

/**
 * OCR 作业 worker（P11 平台预配 A2）：markRunning → 读解密后明文 → ocr.ocr →
 * 成功 completed + ocrText/ocrLayoutBlocks（写 DB，权威）；失败 failed（可重试，OCR_SUBMITTABLE 含 failed）。
 * 重试：ProviderError.retryable=true 时指数退避（backoffBaseMs×2^(n-1)，上限 maxAttempts）；非重试错误快速失败。
 * 真实 OCR 供应商接入点 = PLATFORM_OCR_PROVIDER env（用户确认后替换占位 adapter，本 worker 契约不变）。
 */
async function runOcrJob(options: {
  jobId: string;
  assetId: string;
  teacherId: string;
  getClient: () => Promise<MediaPrismaClient>;
  jobs: BackgroundJobStore;
  storage: StorageService;
  mediaCipher?: MediaFileCipher;
  ocr: OcrAdapter;
  delayMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}): Promise<void> {
  const { jobId, assetId, teacherId, jobs } = options;
  try {
    jobs.markRunning(jobId);
    if (options.delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
    }
    const prisma = await options.getClient();
    const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
    if (!row) {
      jobs.markFailed(jobId, '媒体资产不存在（可能已删除）');
      return;
    }

    // adapter 只见解密后明文 Buffer（存储层读密文 → 服务层解密；密钥不出媒体服务）
    const file = await options.storage.read({ fileRef: row.originalPath });
    if (!file.ok) {
      await failOcr(prisma, assetId, teacherId, jobs, jobId, `读取媒体文件失败：${file.error.message}`);
      return;
    }
    let content: Buffer;
    try {
      content = options.mediaCipher ? options.mediaCipher.decrypt(file.value) : file.value;
    } catch (error) {
      await failOcr(
        prisma,
        assetId,
        teacherId,
        jobs,
        jobId,
        `媒体文件解密失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    let lastError = 'OCR 识别失败';
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const result = await options.ocr.ocr({
          assetId,
          sha256: row.sha256,
          content,
          mimeType: row.mimeType,
        });
        await prisma.mediaAsset.update({
          where: { id: assetId, teacherId },
          data: {
            ocrStatus: 'completed',
            ocrText: result.text,
            // Json 列写值需 InputJsonValue 形状（接口缺索引签名，显式断言）；无版面块 → SQL NULL
            ocrLayoutBlocks: result.blocks ? (result.blocks as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          },
        });
        jobs.markSucceeded(jobId, { assetId, ocrStatus: 'completed', provider: options.ocr.provider });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // 只对 ProviderError.retryable 重试（指数退避）；其他异常快速失败，不烧重试次数
        const retryable = error instanceof ProviderError ? error.retryable : false;
        if (!retryable || attempt >= options.maxAttempts) break;
        const backoffMs = options.backoffBaseMs * 2 ** (attempt - 1);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, backoffMs));
      }
    }
    await failOcr(prisma, assetId, teacherId, jobs, jobId, lastError);
  } catch (error) {
    jobs.markFailed(jobId, error instanceof Error ? error.message : String(error));
  }
}

/** 置 failed（DB 权威）→ 作业 failed；DB 更新失败不阻断作业失败标记。 */
async function failOcr(
  prisma: MediaPrismaClient,
  assetId: string,
  teacherId: string,
  jobs: BackgroundJobStore,
  jobId: string,
  message: string,
): Promise<void> {
  await prisma.mediaAsset
    .update({
      where: { id: assetId, teacherId },
      data: { ocrStatus: 'failed' },
    })
    .catch(() => {});
  jobs.markFailed(jobId, message);
}

/**
 * 扫描作业 worker（P12 平台预配 A3/C）：markRunning → 读解密后明文 → scan.scan →
 * clean → scanStatus=clean（清威胁名）；infected → scanStatus=infected + scanThreatName（隔离终态，
 * 作业 succeeded——扫描已完成，结果为命中）；status='error'（引擎级失败）→ scanStatus=error（可重扫）。
 * 重试：ProviderError.retryable=true 时指数退避（backoffBaseMs×2^(n-1)，上限 maxAttempts）；非重试错误快速失败。
 * 真实 ClamAV 供应商接入点 = PLATFORM_SCAN_PROVIDER env（用户确认后替换占位 adapter，本 worker 契约不变）。
 */
async function runScanJob(options: {
  jobId: string;
  assetId: string;
  teacherId: string;
  getClient: () => Promise<MediaPrismaClient>;
  jobs: BackgroundJobStore;
  storage: StorageService;
  mediaCipher?: MediaFileCipher;
  scan: ScanAdapter;
  delayMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}): Promise<void> {
  const { jobId, assetId, teacherId, jobs } = options;
  try {
    jobs.markRunning(jobId);
    if (options.delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
    }
    const prisma = await options.getClient();
    const row = await prisma.mediaAsset.findFirst({ where: { id: assetId, teacherId } });
    if (!row) {
      jobs.markFailed(jobId, '媒体资产不存在（可能已删除）');
      return;
    }

    // adapter 只见解密后明文 Buffer（存储层读密文 → 服务层解密；密钥不出媒体服务）
    const file = await options.storage.read({ fileRef: row.originalPath });
    if (!file.ok) {
      await failScan(prisma, assetId, teacherId, jobs, jobId, `读取媒体文件失败：${file.error.message}`);
      return;
    }
    let content: Buffer;
    try {
      content = options.mediaCipher ? options.mediaCipher.decrypt(file.value) : file.value;
    } catch (error) {
      await failScan(
        prisma,
        assetId,
        teacherId,
        jobs,
        jobId,
        `媒体文件解密失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    let lastError = '病毒扫描失败';
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const result = await options.scan.scan({
          assetId,
          sha256: row.sha256,
          content,
          mimeType: row.mimeType,
        });
        if (result.status === 'clean') {
          await prisma.mediaAsset.update({
            where: { id: assetId, teacherId },
            data: { scanStatus: 'clean', scanThreatName: null },
          });
          jobs.markSucceeded(jobId, { assetId, scanStatus: 'clean', provider: options.scan.provider });
          return;
        }
        if (result.status === 'infected') {
          // 隔离终态：元数据标记 infected + 威胁名（下载/证据关联由 readFile/captureEvidence 拒绝）
          await prisma.mediaAsset.update({
            where: { id: assetId, teacherId },
            data: { scanStatus: 'infected', scanThreatName: result.threatName ?? null },
          });
          jobs.markSucceeded(jobId, {
            assetId,
            scanStatus: 'infected',
            threatName: result.threatName ?? null,
            provider: options.scan.provider,
          });
          return;
        }
        // status === 'error'：引擎级失败（未完成扫描）——落 error（可重扫），作业 failed
        lastError = result.message ?? `扫描引擎返回 error（provider=${options.scan.provider}）`;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // 只对 ProviderError.retryable 重试（指数退避）；其他异常快速失败，不烧重试次数
        const retryable = error instanceof ProviderError ? error.retryable : false;
        if (!retryable || attempt >= options.maxAttempts) break;
        const backoffMs = options.backoffBaseMs * 2 ** (attempt - 1);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, backoffMs));
      }
    }
    await failScan(prisma, assetId, teacherId, jobs, jobId, lastError);
  } catch (error) {
    jobs.markFailed(jobId, error instanceof Error ? error.message : String(error));
  }
}

/** 置 error（DB 权威，可重扫）→ 作业 failed；DB 更新失败不阻断作业失败标记。 */
async function failScan(
  prisma: MediaPrismaClient,
  assetId: string,
  teacherId: string,
  jobs: BackgroundJobStore,
  jobId: string,
  message: string,
): Promise<void> {
  await prisma.mediaAsset
    .update({
      where: { id: assetId, teacherId },
      data: { scanStatus: 'error' },
    })
    .catch(() => {});
  jobs.markFailed(jobId, message);
}

/** 短随机 id（cuid 风格前缀，无外部依赖；幂等键另有 sha256）。 */
function cryptoRandomId(): string {
  return `asset_${randomBytes(12).toString('hex')}`;
}
