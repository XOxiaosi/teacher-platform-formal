/**
 * 媒体资产类型（P8 S3 多媒体证据链阶段一 · t8 + P9 阶段二 · t3）。
 *
 * 字段语义见 schema MediaAsset 模型与 p7-media-evidence-design.md §阶段一/§阶段二。
 */

import type { CommonError, Result } from '@teacher-platform/contracts';

export const MEDIA_TYPES = ['image', 'screenshot', 'audio', 'document'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** 阶段一白名单：image/screenshot（png/jpeg/webp）；audio/document 阶段二启用。 */
export const PHASE1_MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'screenshot']);

export const PHASE1_MIME_WHITELIST: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** 阶段一上传上限（设计 §4.3）：image/screenshot 10MB。 */
export const PHASE1_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 阶段二（t6）白名单：audio（mp3/wav/m4a 魔数嗅探；design §4.2-1）。 */
export const PHASE2_MEDIA_TYPES: ReadonlySet<string> = new Set(['audio']);

export const PHASE2_AUDIO_MIME_WHITELIST: ReadonlySet<string> = new Set([
  'audio/mpeg', // mp3（ID3 / MPEG 帧同步）
  'audio/wav', // wav（RIFF....WAVE）
  'audio/mp4', // m4a（....ftyp 品牌）
]);

/** 阶段二（t6）audio 上传上限（设计 §4.3）：30MB（约 30-60 分钟压缩音频）。 */
export const PHASE2_MAX_AUDIO_BYTES = 30 * 1024 * 1024;

/** 转写状态（阶段二字段流转占位；阶段三接入真实 ASR 平台预配线）。 */
export const TRANSCRIPTION_STATUSES = ['none', 'pending', 'completed', 'failed'] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

/** 可提交转写的起始状态（none=首次 / failed=失败重试）；提交后 → pending。 */
export const TRANSCRIPTION_SUBMITTABLE: ReadonlySet<TranscriptionStatus> = new Set(['none', 'failed']);

/** OCR 状态（P11 平台预配 A2：图片识别占位流转；阶段三-B 接入真实 OCR 平台预配线）。 */
export const OCR_STATUSES = ['none', 'pending', 'completed', 'failed'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

/** 可提交 OCR 的起始状态（none=首次 / failed=失败重试）；提交后 → pending。 */
export const OCR_SUBMITTABLE: ReadonlySet<OcrStatus> = new Set(['none', 'failed']);

/** OCR 版面块（MediaAnalysis.layoutBlocks 输入；bbox=null 表示无位置信息，jsonb 存储）。 */
export interface OcrLayoutBlock {
  text: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

/** 扫描状态（阶段二字段流转占位；P12 A3/C 接入真实病毒扫描驱动）。 */
export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'error', 'skipped'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** 可提交扫描的起始状态（skipped=首次 / clean=重扫 / error=失败重试）；提交后 → pending。 */
export const SCAN_SUBMITTABLE: ReadonlySet<ScanStatus> = new Set(['skipped', 'clean', 'error']);

/** 孤儿回收状态。 */
export const ORPHAN_STATUSES = ['active', 'orphan'] as const;
export type OrphanStatus = (typeof ORPHAN_STATUSES)[number];

export interface MediaUploadInput {
  teacherId: string;
  /** image | screenshot | audio | document（阶段一仅 image/screenshot）。 */
  mediaType: string;
  /** 客户端原始文件名（仅展示用，不参与落盘）。 */
  originalFilename: string;
  /** 客户端声明的 mime（仅参考，以服务端 magic bytes 嗅探为准）。 */
  mimeType: string;
  content: Buffer;
  /** 上传时已识别学生（可选；提供则自动捕获 StudentSourceRecord，未识别进待归档箱）。 */
  studentId?: string;
  /** 证据发生时间（可选；缺省 = 上传时间）。 */
  occurredAt?: Date;
}

export interface MediaAssetDto {
  id: string;
  teacherId: string;
  mediaType: string;
  sha256: string;
  /** 幂等去重命中时 = 已有资产 id；新资产 = null。 */
  duplicateOf: string | null;
  mimeType: string;
  sizeBytes: number;
  privacyLevel: string;
  scanStatus: string;
  /** ASR 转写状态（none | pending | completed | failed；阶段三真实 ASR）。 */
  transcriptionStatus: string;
  /** 转写文本（t6 占位：作业完成写入占位文本；阶段三真实 ASR 结果）。 */
  transcriptionText: string | null;
  /** OCR 识别状态（none | pending | completed | failed；P11 A2 占位流转，阶段三-B 真实 OCR）。 */
  ocrStatus: string;
  /** OCR 识别文本（P11 A2：作业完成写入占位文本；阶段三-B 真实 OCR 结果）。 */
  ocrText: string | null;
  /** OCR 版面块（MediaAnalysis.layoutBlocks 输入；jsonb 存储；completed 时非空数组或 []）。 */
  ocrLayoutBlocks: OcrLayoutBlock[] | null;
  /** 最近扫描作业 jobId（内存作业瞬态关联；重启即失效，以 DB 状态为准）。 */
  scanJobId: string | null;
  /** infected 时命中威胁名（ScanResponse.threatName；管理端可查看）。 */
  scanThreatName: string | null;
  /** 文件级加密版本（'aes-256-gcm' | null=阶段一明文遗留）。 */
  encryptionVersion: string | null;
  /** 孤儿回收状态（active | orphan）。 */
  orphanStatus: string;
  /** 标记 orphan 时刻（TrustedClock；保留期从此刻起算）。 */
  orphanMarkedAtTs: string | null;
  originalPath: string;
  createdAtTs: string;
}

export interface MediaAssetFile {
  row: MediaAssetDto;
  content: Buffer;
}

export interface MediaAssetService {
  upload(input: MediaUploadInput): Promise<Result<MediaAssetDto, CommonError>>;
  getOwned(teacherId: string, assetId: string): Promise<Result<MediaAssetDto, CommonError>>;
  readFile(teacherId: string, assetId: string): Promise<Result<MediaAssetFile, CommonError>>;
  /** 捕获证据：sourceEntityType=MediaAsset 幂等（复用既有 @@unique）。 */
  captureEvidence(input: {
    teacherId: string;
    assetId: string;
    studentId?: string;
    occurredAt?: Date;
  }): Promise<Result<unknown, CommonError>>;
  /**
   * 转写状态流转（阶段二占位：只做状态机校验与落库，真实 ASR 阶段三 shared/platform-services 接入）。
   * 合法流转：none→pending→completed|failed（pending 可重复置 pending=重试）。
   */
  updateTranscriptionStatus(
    teacherId: string,
    assetId: string,
    status: TranscriptionStatus,
  ): Promise<Result<MediaAssetDto, CommonError>>;
  /**
   * 扫描状态流转（阶段二占位：只做状态机校验与落库；P12 A3/C 真实病毒扫描驱动）。
   * 合法流转：skipped|pending→pending→clean|infected|error（阶段一 skipped 保持）。
   */
  updateScanStatus(
    teacherId: string,
    assetId: string,
    status: ScanStatus,
  ): Promise<Result<MediaAssetDto, CommonError>>;
  /**
   * 提交异步扫描作业（P12 A3/C）：scanStatus ∈ {skipped, clean, error} 可提交 → pending
   * + 创建内存作业（background-jobs 心智，owner=teacherId 隔离）+ 清旧威胁名。平台预配 scan
   * 未配置时占位降级（scan 返回 status='error' → scanStatus=error，可重扫，不崩服）；真实 ClamAV
   * 供应商接入点 = PLATFORM_SCAN_PROVIDER env（阶段三-C 替换占位）。
   */
  submitScan(
    teacherId: string,
    assetId: string,
  ): Promise<Result<{ jobId: string; assetId: string; scanStatus: string }, CommonError>>;
  /**
   * 轮询扫描状态（P12 A3/C）：owner 隔离；返回 DB 状态（权威）+ 内存作业状态（瞬态，重启即清）。
   */
  getScan(
    teacherId: string,
    assetId: string,
  ): Promise<Result<{
    assetId: string;
    scanStatus: string;
    scanThreatName: string | null;
    job: { jobId: string; status: string; error: string | null } | null;
  }, CommonError>>;
  /**
   * 提交异步转写作业（t6）：仅 audio 且 transcriptionStatus ∈ {none, failed} 可提交 → pending
   * + 创建内存作业（background-jobs 心智，owner=teacherId 隔离）。真实 ASR 阶段三 platform-services 预配线，
   * 本任务为作业队列/状态流转/接口契约占位。
   */
  submitTranscription(
    teacherId: string,
    assetId: string,
  ): Promise<Result<{ jobId: string; assetId: string; transcriptionStatus: string }, CommonError>>;
  /**
   * 轮询转写状态（t6）：owner 隔离；返回 DB 状态（权威）+ 内存作业状态（瞬态，重启即清）。
   */
  getTranscription(
    teacherId: string,
    assetId: string,
  ): Promise<Result<{
    assetId: string;
    transcriptionStatus: string;
    transcriptionText: string | null;
    job: { jobId: string; status: string; error: string | null } | null;
  }, CommonError>>;
  /**
   * OCR 状态流转（P11 A2 占位：只做状态机校验与落库，真实 OCR 阶段三-B shared/platform-services 接入）。
   * 合法流转：none→pending→completed|failed（pending 可重复置 pending=重试）。
   */
  updateOcrStatus(
    teacherId: string,
    assetId: string,
    status: OcrStatus,
  ): Promise<Result<MediaAssetDto, CommonError>>;
  /**
   * 提交异步 OCR 作业（P11 A2）：仅 image/screenshot 且 ocrStatus ∈ {none, failed} 可提交 → pending
   * + 创建内存作业（background-jobs 心智，owner=teacherId 隔离）+ 清旧结果。真实 OCR 阶段三-B
   * platform-services 预配线；本任务为作业队列/状态流转/接口契约（占位 adapter 驱动流转）。
   */
  submitOcr(
    teacherId: string,
    assetId: string,
  ): Promise<Result<{ jobId: string; assetId: string; ocrStatus: string }, CommonError>>;
  /**
   * 轮询 OCR 状态（P11 A2）：owner 隔离；返回 DB 状态（权威）+ 内存作业状态（瞬态，重启即清）。
   */
  getOcr(
    teacherId: string,
    assetId: string,
  ): Promise<Result<{
    assetId: string;
    ocrStatus: string;
    ocrText: string | null;
    ocrLayoutBlocks: OcrLayoutBlock[] | null;
    job: { jobId: string; status: string; error: string | null } | null;
  }, CommonError>>;
}
