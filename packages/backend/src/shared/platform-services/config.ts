/**
 * 平台预配服务 env 解析（P10 平台预配线 · t6，设计 §4）。
 *
 * 平台级配置（env 为主，非教师 ProviderConfig）：
 * - PLATFORM_SERVICES_ENABLED     总开关；false（缺省）→ 门面返回空（全部降级）
 * - PLATFORM_ASR_PROVIDER         ASR 供应商：none(缺省) | tencent | whisper | ...
 *   真实供应商（tencent/whisper）接入需用户确认（未成年人语音数据出域红线）；A1 一律占位降级。
 * - PLATFORM_OCR_PROVIDER         OCR 供应商：none(缺省) | tencent | aliyun | baidu | paddle（A2 占位降级）
 * - PLATFORM_MODERATION_PROVIDER  文本审核供应商：none(缺省=off) | local | external（D 切片：
 *   local=本地规则内置引擎（零出域）；external=云审核占位（本地规则优先，外部待用户确认出域后实现））
 * - PLATFORM_MODERATION_LOCAL     本地规则引擎开关：on(缺省) | off（off = 禁用本地规则，external 时也不做本地先行）
 * - PLATFORM_SCAN_PROVIDER        病毒扫描供应商：none(缺省) | clamav | tencent（阶段三-C 占位）
 * - PLATFORM_SCAN_CLAMAV_HOST/PORT ClamAV daemon 地址（缺省 127.0.0.1/3310；真实 adapter 阶段三-C 使用）
 *
 * 沿用既有 parseXxxEnv(env = process.env) 模式（wechat/agent-cost/database-pool 同款），
 * 测试可注入 env 对象。
 */

export interface PlatformServicesConfig {
  /** PLATFORM_SERVICES_ENABLED === 'true'（严格匹配，避免 '1'/'TRUE' 误开）。 */
  enabled: boolean;
  /** PLATFORM_ASR_PROVIDER 小写归一；缺省 'none'。 */
  asrProvider: string;
  /** PLATFORM_OCR_PROVIDER 小写归一；缺省 'none'。 */
  ocrProvider: string;
  /** PLATFORM_MODERATION_PROVIDER 小写归一；缺省 'none'（默认 off）。 */
  moderationProvider: string;
  /** PLATFORM_MODERATION_LOCAL：本地规则引擎开关；缺省 true（on）；仅显式 'off' 关闭。 */
  moderationLocal: boolean;
  /** PLATFORM_SCAN_PROVIDER 小写归一；缺省 'none'（阶段三-C：病毒扫描）。 */
  scanProvider: string;
  /** PLATFORM_SCAN_CLAMAV_HOST 归一；缺省 '127.0.0.1'（真实 ClamAV adapter 使用）。 */
  clamavHost: string;
  /** PLATFORM_SCAN_CLAMAV_PORT 解析；缺省 3310（真实 ClamAV adapter 使用）。 */
  clamavPort: number;
}

export const PLATFORM_SERVICES_ENABLED_ENV = 'PLATFORM_SERVICES_ENABLED';
export const PLATFORM_ASR_PROVIDER_ENV = 'PLATFORM_ASR_PROVIDER';
export const PLATFORM_OCR_PROVIDER_ENV = 'PLATFORM_OCR_PROVIDER';
export const PLATFORM_MODERATION_PROVIDER_ENV = 'PLATFORM_MODERATION_PROVIDER';
export const PLATFORM_MODERATION_LOCAL_ENV = 'PLATFORM_MODERATION_LOCAL';
export const PLATFORM_SCAN_PROVIDER_ENV = 'PLATFORM_SCAN_PROVIDER';
export const PLATFORM_SCAN_CLAMAV_HOST_ENV = 'PLATFORM_SCAN_CLAMAV_HOST';
export const PLATFORM_SCAN_CLAMAV_PORT_ENV = 'PLATFORM_SCAN_CLAMAV_PORT';

/** ASR 供应商枚举（A1 真实 adapter 未实现——待用户确认后阶段三-A 后续启用）。 */
export const ASR_PROVIDERS = ['none', 'tencent', 'iflytek', 'aliyun', 'whisper'] as const;
export type AsrProvider = (typeof ASR_PROVIDERS)[number];

/** OCR 供应商枚举（A2 真实 adapter 未实现——待用户确认后阶段三-B 后续启用）。 */
export const OCR_PROVIDERS = ['none', 'tencent', 'aliyun', 'baidu', 'paddle'] as const;
export type OcrProvider = (typeof OCR_PROVIDERS)[number];

/** 文本审核供应商枚举（D 切片：none=off 基线；local=本地规则内置引擎零出域；external=云审核占位待用户确认出域）。 */
export const MODERATION_PROVIDERS = ['none', 'local', 'external'] as const;
export type ModerationProvider = (typeof MODERATION_PROVIDERS)[number];

/** 病毒扫描供应商枚举（阶段三-C：clamav=本地自建首选；tencent=对象存储就绪后评估，预留）。 */
export const SCAN_PROVIDERS = ['none', 'clamav', 'tencent'] as const;
export type ScanProvider = (typeof SCAN_PROVIDERS)[number];

export function parsePlatformServicesEnv(env: NodeJS.ProcessEnv = process.env): PlatformServicesConfig {
  const enabled = env[PLATFORM_SERVICES_ENABLED_ENV] === 'true';
  const asrProvider = (env[PLATFORM_ASR_PROVIDER_ENV] ?? 'none').trim().toLowerCase();
  const ocrProvider = (env[PLATFORM_OCR_PROVIDER_ENV] ?? 'none').trim().toLowerCase();
  const moderationProvider = (env[PLATFORM_MODERATION_PROVIDER_ENV] ?? 'none').trim().toLowerCase();
  const moderationLocal = (env[PLATFORM_MODERATION_LOCAL_ENV] ?? 'on').trim().toLowerCase() !== 'off';
  const scanProvider = (env[PLATFORM_SCAN_PROVIDER_ENV] ?? 'none').trim().toLowerCase();
  const clamavHost = (env[PLATFORM_SCAN_CLAMAV_HOST_ENV] ?? '127.0.0.1').trim();
  const clamavPortRaw = Number(env[PLATFORM_SCAN_CLAMAV_PORT_ENV] ?? '3310');
  const clamavPort = Number.isInteger(clamavPortRaw) && clamavPortRaw > 0 && clamavPortRaw < 65536 ? clamavPortRaw : 3310;
  return { enabled, asrProvider, ocrProvider, moderationProvider, moderationLocal, scanProvider, clamavHost, clamavPort };
}
