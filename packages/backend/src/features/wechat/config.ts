import type { WechatIlinkConfig } from './types.js';

/**
 * 平台级 iLink 配置解析（设计 p7-wechat-ilink-design.md §8.1）。
 *
 * 风格同 ADMIN_EMAIL / ACTION_TOKEN_SECRET：
 * - 平台级参数走 env（appid/secret/token 属应用，不进教师配置）；
 * - WECHAT_ILINK_ENABLED=true 时关键项缺失 → 启动抛错（红线，fail-closed）；
 * - 默认全部关闭/保守（总开关 false、白名单空=全拒）。
 */

const DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * 逗号分隔 IP/CIDR 白名单解析（去空白、去空项）。
 * P14 t6：支持 IPv4/IPv6 混合多组（如 "127.0.0.1, 203.0.113.0/24, 240e:390::/38"）——
 * 匹配逻辑见 ip-whitelist.ts（IPv4-mapped 归一 + IPv6 CIDR）。
 */
export function parseIpList(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 逗号分隔正整数列表解析（退避序列等；非法/空 → fallback）。 */
export function parsePositiveIntList(value: string | undefined, fallback: number[]): number[] {
  if (!value || value.trim() === '') return fallback;
  const parsed = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return parsed.length > 0 ? parsed : fallback;
}

export function parseWechatIlinkEnv(env: NodeJS.ProcessEnv = process.env): WechatIlinkConfig {
  const enabled = env.WECHAT_ILINK_ENABLED === 'true';
  const config: WechatIlinkConfig = {
    enabled,
    appid: env.WECHAT_ILINK_APPID ?? '',
    appSecret: env.WECHAT_ILINK_APPSECRET ?? '',
    token: env.WECHAT_ILINK_TOKEN ?? '',
    apiBaseUrl: env.WECHAT_ILINK_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    allowedIps: parseIpList(env.WECHAT_ILINK_ALLOWED_IPS),
    stateTtlMs: parsePositiveInt(env.WECHAT_ILINK_STATE_TTL_MS, 5 * 60 * 1000),
    timestampWindowMs: parsePositiveInt(env.WECHAT_ILINK_TIMESTAMP_WINDOW_MS, 5 * 60 * 1000),
    qrcodeRatePerMin: parsePositiveInt(env.WECHAT_ILINK_QRCODE_RATE_PER_MIN, 20),
    callbackRatePerMin: parsePositiveInt(env.WECHAT_ILINK_CALLBACK_RATE_PER_MIN, 60),
    bindRatePerMin: parsePositiveInt(env.WECHAT_ILINK_BIND_RATE_PER_MIN, 60),
    inboundPerMin: parsePositiveInt(env.WECHAT_ILINK_INBOUND_PER_MIN, 10),
    notifyRatePerMin: parsePositiveInt(env.WECHAT_ILINK_NOTIFY_PER_MIN, 60),
    maxTextLength: parsePositiveInt(env.WECHAT_ILINK_MAX_TEXT_LENGTH, 1500),
    recoveryIntervalMs: parsePositiveInt(env.WECHAT_ILINK_RECOVERY_INTERVAL_MS, 5 * 60 * 1000),
    unboundMaxPendingMs: parsePositiveInt(env.WECHAT_ILINK_UNBOUND_MAX_PENDING_MS, 24 * 60 * 60 * 1000),
    webhookTimeoutMs: parsePositiveInt(env.WECHAT_ILINK_WEBHOOK_TIMEOUT_MS, 4000),
    maxStateKeys: parsePositiveInt(env.WECHAT_ILINK_MAX_STATE_KEYS, 100_000),
    botToken: env.WECHAT_ILINK_BOT_TOKEN ?? '',
    longPollTimeoutMs: parsePositiveInt(env.WECHAT_ILINK_LONG_POLL_TIMEOUT_MS, 40_000),
    pollBackoffMs: parsePositiveIntList(env.WECHAT_ILINK_POLL_BACKOFF_MS, [2000, 5000, 30_000]),
    maxConsecutivePollFailures: parsePositiveInt(env.WECHAT_ILINK_MAX_POLL_FAILURES, 3),
    contextTokenTtlMs: parsePositiveInt(env.WECHAT_ILINK_CONTEXT_TOKEN_TTL_MS, 24 * 60 * 60 * 1000),
    outboundTimeoutMs: parsePositiveInt(env.WECHAT_ILINK_OUTBOUND_TIMEOUT_MS, 15_000),
  };
  if (enabled && (!config.appid || !config.appSecret || !config.token)) {
    throw new Error(
      'WECHAT_ILINK_ENABLED=true 时 WECHAT_ILINK_APPID / WECHAT_ILINK_APPSECRET / WECHAT_ILINK_TOKEN 必填（启动红线，同 ADMIN_EMAIL 风格）',
    );
  }
  return config;
}
