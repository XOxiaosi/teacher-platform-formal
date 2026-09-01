/**
 * 平台预配服务门面（P10 平台预配线 · t6 + P11 A2 · t1 + P16 真实供应商骨架 · t3，设计 §3.2；
 * 骨架契约 p13-provider-adapter-assessment.md §8）。
 *
 * createPlatformServices(env)：按平台级 env 装配 adapter 集合——
 * - PLATFORM_SERVICES_ENABLED !== 'true' → 返回空门面（{}），所有服务未配置（调用方降级，不崩服）；
 * - 启用后按 PLATFORM_ASR_PROVIDER 装配 asr（§8.1 装配分支）：
 *   · none（缺省）→ 占位 adapter（未配置用占位，任务项 3）；
 *   · whisper → 骨架 adapter（不出域默认；T7 资源确认前占位降级——已配置但未确认，绝不静默假装可用）；
 *   · tencent → 骨架 adapter（出域；T1+T5+T6 用户确认前占位降级）；
 *   · 其他 → 占位降级并标注接入点（不崩服）。
 * - 按 PLATFORM_OCR_PROVIDER 装配 ocr（A2，§8.2 装配分支）：none（缺省）→ 占位 adapter（占位文本 +
 *   空版面块，保证 OCR 作业流转基线不破坏，同 A1 心智）；paddle → 骨架（T8 前占位降级）；
 *   tencent → 骨架（T2+T5+T6 前占位降级）；其他 → 占位降级。
 * - 按 PLATFORM_MODERATION_PROVIDER 装配 moderation（D 切片）：none（缺省）→ 不实例化
 *   （services.moderation === undefined，调用方走未配置分支）；local → 本地规则内置引擎（零出域）；
 *   external → 腾讯云天御骨架（本地规则优先，云调用待用户确认 T4+T5+T6 出域后实现）；
 *   未知供应商 → 占位降级不崩服。
 * - 按 PLATFORM_SCAN_PROVIDER 装配 scan（A3/C，§8.3 装配分支）：none（缺省）→ 不实例化
 *   （services.scan === undefined，上传保持 scanStatus=skipped——阶段二基线零破坏）；
 *   clamav → 骨架 adapter（T9 资源确认前占位降级：scan 返回 status='error'，不静默放行也不误杀）；
 *   其他 → 占位降级。
 *
 * 不抛错：任何配置组合都返回可用的门面（降级不崩服纪律）；真实供应商骨架在用户确认前一律
 * 占位降级（不实现真实 HTTP 调用，红线：用户确认前不接云）。
 */

import { parsePlatformServicesEnv } from './config.js';
import { createPlaceholderAsrAdapter } from './asr/placeholder.js';
import { createWhisperAsrAdapter } from './asr/whisper.js';
import { createTencentAsrAdapter } from './asr/tencent.js';
import { createPlaceholderOcrAdapter } from './ocr/placeholder.js';
import { createPaddleOcrAdapter } from './ocr/paddle.js';
import { createTencentOcrAdapter } from './ocr/tencent.js';
import { createLocalModerationAdapter } from './moderation/local.js';
import { createExternalModerationAdapter } from './moderation/external.js';
import { createPlaceholderModerationAdapter } from './moderation/placeholder.js';
import { createPlaceholderScanAdapter } from './scan/placeholder.js';
import { createClamavScanAdapter } from './scan/clamav.js';
import type { PlatformServices } from './types.js';

export function createPlatformServices(env: NodeJS.ProcessEnv = process.env): PlatformServices {
  const config = parsePlatformServicesEnv(env);
  if (!config.enabled) {
    return {};
  }
  const services: PlatformServices = {};
  // A1（§8.1）：按 provider 名装配——whisper/tencent = 真实供应商骨架（未确认 → 占位降级）；缺省/未知 → 占位
  switch (config.asrProvider) {
    case 'whisper':
      services.asr = createWhisperAsrAdapter(env);
      break;
    case 'tencent':
      services.asr = createTencentAsrAdapter(env);
      break;
    default:
      services.asr = createPlaceholderAsrAdapter(config.asrProvider);
  }
  // A2（§8.2）：paddle/tencent = 真实供应商骨架（未确认 → 占位降级）；缺省/未知 → 占位（同 asr 心智）
  switch (config.ocrProvider) {
    case 'paddle':
      services.ocr = createPaddleOcrAdapter(env);
      break;
    case 'tencent':
      services.ocr = createTencentOcrAdapter(env);
      break;
    default:
      services.ocr = createPlaceholderOcrAdapter(config.ocrProvider);
  }
  // D 切片：文本审核默认 off——provider=none 不实例化（避免无效依赖）；
  // local → 本地规则内置引擎（零出域）；external → 云审核占位（本地优先，外部待用户确认出域）；
  // 未知供应商（含历史 tencent 等）→ 占位降级不崩服（review 心智）
  if (config.moderationProvider === 'local') {
    services.moderation = createLocalModerationAdapter(env);
  } else if (config.moderationProvider === 'external') {
    services.moderation = createExternalModerationAdapter(env);
  } else if (config.moderationProvider !== 'none' && config.moderationProvider !== '') {
    services.moderation = createPlaceholderModerationAdapter(config.moderationProvider);
  }
  // A3/C（§8.3）：clamav = 真实供应商骨架（T9 资源确认前占位降级：scan → status='error'，
  // 不静默放行也不误杀）；其他已配置未实现 → 占位降级；none（缺省）→ 不实例化
  // （上传保持 skipped，基线零破坏）
  if (config.scanProvider === 'clamav') {
    services.scan = createClamavScanAdapter(env);
  } else if (config.scanProvider !== 'none' && config.scanProvider !== '') {
    services.scan = createPlaceholderScanAdapter(config.scanProvider);
  }
  return services;
}

// 配置解析（env 契约，设计 §4）
export {
  ASR_PROVIDERS,
  MODERATION_PROVIDERS,
  OCR_PROVIDERS,
  PLATFORM_ASR_PROVIDER_ENV,
  PLATFORM_MODERATION_LOCAL_ENV,
  PLATFORM_MODERATION_PROVIDER_ENV,
  PLATFORM_OCR_PROVIDER_ENV,
  PLATFORM_SCAN_CLAMAV_HOST_ENV,
  PLATFORM_SCAN_CLAMAV_PORT_ENV,
  PLATFORM_SCAN_PROVIDER_ENV,
  PLATFORM_SERVICES_ENABLED_ENV,
  SCAN_PROVIDERS,
  parsePlatformServicesEnv,
} from './config.js';
export type { AsrProvider, ModerationProvider, OcrProvider, PlatformServicesConfig, ScanProvider } from './config.js';

// 占位 adapter（未配置降级，任务项 1/3）
export { PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT, createPlaceholderAsrAdapter } from './asr/placeholder.js';
export { PLATFORM_OCR_PLACEHOLDER_TEXT, createPlaceholderOcrAdapter } from './ocr/placeholder.js';
export { PLATFORM_MODERATION_PLACEHOLDER_LABEL, createPlaceholderModerationAdapter } from './moderation/placeholder.js';
export { PLATFORM_SCAN_PLACEHOLDER_ERROR, createPlaceholderScanAdapter } from './scan/placeholder.js';

// P16 t3：真实供应商 adapter 骨架（§8 契约；未确认 → 占位降级，不实现真实调用）
export {
  PLATFORM_ASR_API_KEY_ENV,
  PLATFORM_ASR_BASE_URL_ENV,
  PLATFORM_ASR_MODEL_ENV,
  WHISPER_PENDING_CONFIRMATION_TEXT,
  createWhisperAsrAdapter,
  readWhisperAsrConfig,
  validateWhisperAsrConfig,
} from './asr/whisper.js';
export {
  PLATFORM_ASR_SECRET_ID_ENV,
  PLATFORM_ASR_SECRET_KEY_ENV,
  TENCENT_ASR_PENDING_CONFIRMATION_TEXT,
  createTencentAsrAdapter,
  readTencentAsrConfig,
  validateTencentAsrConfig,
} from './asr/tencent.js';
export {
  PLATFORM_OCR_BASE_URL_ENV,
  PADDLE_OCR_PENDING_CONFIRMATION_TEXT,
  createPaddleOcrAdapter,
  readPaddleOcrConfig,
  validatePaddleOcrConfig,
} from './ocr/paddle.js';
export {
  PLATFORM_OCR_API_KEY_ENV,
  PLATFORM_OCR_SECRET_ID_ENV,
  PLATFORM_OCR_SECRET_KEY_ENV,
  TENCENT_OCR_PENDING_CONFIRMATION_TEXT,
  createTencentOcrAdapter,
  readTencentOcrConfig,
  validateTencentOcrConfig,
} from './ocr/tencent.js';
export {
  CLAMAV_PENDING_CONFIRMATION_MESSAGE,
  createClamavScanAdapter,
  readClamavScanConfig,
} from './scan/clamav.js';

// D 切片：本地规则引擎 + 本地/外部 moderation adapter
export { LOCAL_MODERATION_RULES, moderateWithLocalRules } from './moderation/rules.js';
export { LOCAL_MODERATION_DISABLED_LABEL, createLocalModerationAdapter } from './moderation/local.js';
export {
  EXTERNAL_MODERATION_PLACEHOLDER_LABEL,
  PLATFORM_MODERATION_API_KEY_ENV,
  PLATFORM_MODERATION_SECRET_ID_ENV,
  PLATFORM_MODERATION_SECRET_KEY_ENV,
  TENCENT_TIANYU_PENDING_LABEL,
  createExternalModerationAdapter,
  createTencentModerationAdapter,
  readTencentModerationConfig,
  validateTencentModerationConfig,
} from './moderation/external.js';

// 统一契约（设计 §3）
export type {
  AsrAdapter,
  ModerationAdapter,
  ModerationRequest,
  ModerationResponse,
  OcrAdapter,
  OcrLayoutBlock,
  OcrRequest,
  OcrResponse,
  PlatformServiceKind,
  PlatformServices,
  ScanAdapter,
  ScanRequest,
  ScanResponse,
  TranscribeRequest,
  TranscribeResponse,
} from './types.js';

// 错误归一：复用 llm-provider-compat 的 ProviderError 心智（设计 §3.1，零新错误类型）
export { ProviderError, providerError } from './types.js';
export type { PlatformServiceError } from './types.js';
