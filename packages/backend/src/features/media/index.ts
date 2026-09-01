export { createMediaAssetService } from './media-asset-service.js';
export { createMediaOrphanReaper, DEFAULT_ORPHAN_RETENTION_MS } from './media-orphan-reaper.js';
export type { CreateMediaOrphanReaperOptions, MediaOrphanReaper } from './media-orphan-reaper.js';
export {
  MEDIA_ENC_HEADER_BYTES,
  MEDIA_ENCRYPTION_KEY_ENV,
  MEDIA_ENCRYPTION_VERSION,
  createMediaFileCipher,
  createMediaFileCipherFromEnv,
  decryptMediaFile,
  encryptMediaFile,
  isMediaEncryptedFile,
  loadMediaEncryptionKey,
} from './media-file-crypto.js';
export type { MediaFileCipher } from './media-file-crypto.js';
export {
  MEDIA_TYPES,
  OCR_STATUSES,
  OCR_SUBMITTABLE,
  ORPHAN_STATUSES,
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
} from './types.js';
export type {
  MediaAssetDto,
  MediaAssetFile,
  MediaAssetService,
  MediaUploadInput,
  OcrLayoutBlock,
  OcrStatus,
  OrphanStatus,
  ScanStatus,
  TranscriptionStatus,
} from './types.js';
