import { randomBytes } from 'node:crypto';
import {
  err,
  validationError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
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
  type MediaUploadInput,
  type OcrLayoutBlock,
  type OcrStatus,
  type ScanStatus,
  type TranscriptionStatus,
} from './types.js';

export const DEFAULT_PRIVACY_LEVEL = 'S1';
export const DEFAULT_SCAN_STATUS = 'skipped';
export const DEFAULT_TRANSCRIPTION_STATUS = 'none';
export const DEFAULT_OCR_STATUS = 'none';
export const DEFAULT_TRANSCRIPTION_MAX_ATTEMPTS = 5;
export const DEFAULT_TRANSCRIPTION_BACKOFF_BASE_MS = 1000;
export const DEFAULT_OCR_MAX_ATTEMPTS = 5;
export const DEFAULT_OCR_BACKOFF_BASE_MS = 1000;
export const DEFAULT_SCAN_MAX_ATTEMPTS = 5;
export const DEFAULT_SCAN_BACKOFF_BASE_MS = 1000;

export const TRANSCRIPTION_TRANSITIONS: Record<TranscriptionStatus, ReadonlySet<TranscriptionStatus>> = {
  none: new Set(['pending']),
  pending: new Set(['pending', 'completed', 'failed']),
  completed: new Set([]),
  failed: new Set(['pending']),
};

export const OCR_TRANSITIONS: Record<OcrStatus, ReadonlySet<OcrStatus>> = {
  none: new Set(['pending']),
  pending: new Set(['pending', 'completed', 'failed']),
  completed: new Set([]),
  failed: new Set(['pending']),
};

export const SCAN_TRANSITIONS: Record<ScanStatus, ReadonlySet<ScanStatus>> = {
  pending: new Set(['pending', 'clean', 'infected', 'error']),
  clean: new Set(['pending']),
  infected: new Set([]),
  error: new Set(['pending']),
  skipped: new Set(['pending']),
};

function sniffMimeType(content: Buffer): string | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (content.length >= 12 && content.subarray(0, 4).toString('latin1') === 'RIFF' && content.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function sniffAudioMimeType(content: Buffer): string | null {
  if (content.length >= 3 && content.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (content.length >= 2 && content[0] === 0xff && (content[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (content.length >= 12 && content.subarray(0, 4).toString('latin1') === 'RIFF' && content.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (content.length >= 12 && content.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  return null;
}

export function validateUpload(input: MediaUploadInput): Result<{ mediaType: string; mimeType: string }, CommonError> {
  if (!MEDIA_TYPES.includes(input.mediaType as (typeof MEDIA_TYPES)[number])) {
    return err(validationError('mediaType 必须是 image | screenshot | audio | document', 'mediaType'));
  }
  if (input.content.length === 0) return err(validationError('文件不能为空', 'file'));
  if (PHASE2_MEDIA_TYPES.has(input.mediaType)) {
    const sniffed = sniffAudioMimeType(input.content);
    if (!sniffed) return err(validationError('文件内容不是支持的音频格式（MP3/WAV/M4A 魔数校验失败）', 'file'));
    if (!PHASE2_AUDIO_MIME_WHITELIST.has(sniffed)) return err(validationError(`不支持的文件类型（嗅探为 ${sniffed}）`, 'file'));
    if (input.content.length > PHASE2_MAX_AUDIO_BYTES) return err(validationError(`音频超过大小上限 ${PHASE2_MAX_AUDIO_BYTES / 1024 / 1024}MB`, 'file'));
    return { ok: true, value: { mediaType: input.mediaType, mimeType: sniffed } };
  }
  if (!PHASE1_MEDIA_TYPES.has(input.mediaType)) return err(validationError(`mediaType=${input.mediaType} 阶段未启用（仅 image/screenshot/audio）`, 'mediaType'));
  const sniffed = sniffMimeType(input.content);
  if (!sniffed) return err(validationError('文件内容不是支持的图片格式（PNG/JPEG/WebP 魔数校验失败）', 'file'));
  if (!PHASE1_MIME_WHITELIST.has(sniffed)) return err(validationError(`不支持的文件类型（嗅探为 ${sniffed}）`, 'file'));
  if (input.content.length > PHASE1_MAX_IMAGE_BYTES) return err(validationError(`图片超过大小上限 ${PHASE1_MAX_IMAGE_BYTES / 1024 / 1024}MB`, 'file'));
  return { ok: true, value: { mediaType: input.mediaType, mimeType: sniffed } };
}

export function normalizeConfidence(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('识别供应商返回的置信度必须是 0 到 1 之间的数值');
  return value;
}

export function toDto(row: {
  id: string; teacherId: string; mediaType: string; sha256: string; duplicateOf: string | null; mimeType: string; sizeBytes: number;
  privacyLevel: string; scanStatus: string; transcriptionStatus: string; transcriptionText: string | null; transcriptionConfidence: number | null;
  ocrStatus: string; ocrText: string | null; ocrConfidence: number | null; ocrLayoutBlocks: unknown; scanJobId: string | null;
  scanThreatName: string | null; encryptionVersion: string | null; orphanStatus: string; orphanMarkedAtTs: Date | null; originalPath: string; createdAtTs: Date;
}, duplicateOfOverride?: string | null): MediaAssetDto {
  return {
    id: row.id, teacherId: row.teacherId, mediaType: row.mediaType, sha256: row.sha256,
    duplicateOf: duplicateOfOverride !== undefined ? duplicateOfOverride : row.duplicateOf,
    mimeType: row.mimeType, sizeBytes: row.sizeBytes, privacyLevel: row.privacyLevel, scanStatus: row.scanStatus,
    transcriptionStatus: row.transcriptionStatus, transcriptionText: row.transcriptionText, transcriptionConfidence: row.transcriptionConfidence,
    ocrStatus: row.ocrStatus, ocrText: row.ocrText, ocrConfidence: row.ocrConfidence,
    ocrLayoutBlocks: (row.ocrLayoutBlocks as OcrLayoutBlock[] | null) ?? null, scanJobId: row.scanJobId,
    scanThreatName: row.scanThreatName, encryptionVersion: row.encryptionVersion, orphanStatus: row.orphanStatus,
    orphanMarkedAtTs: row.orphanMarkedAtTs ? row.orphanMarkedAtTs.toISOString() : null, originalPath: row.originalPath,
    createdAtTs: row.createdAtTs.toISOString(),
  };
}

export function cryptoRandomId(): string {
  return `asset_${randomBytes(12).toString('hex')}`;
}

export { OCR_STATUSES, OCR_SUBMITTABLE, SCAN_STATUSES, SCAN_SUBMITTABLE, TRANSCRIPTION_STATUSES, TRANSCRIPTION_SUBMITTABLE };
