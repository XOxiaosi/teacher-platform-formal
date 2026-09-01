import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 微信回调验签（设计 p7-wechat-ilink-design.md §6.1，公众号/webhook 惯例）：
 *   signature = sha1(sort([token, timestamp, nonce]).join(''))
 * 校验顺序（路由层）：IP 白名单 → timestamp ±window → timingSafeEqual 验签 → 解析消息。
 * 失败一律静默丢弃（accepted=false），不返回业务错误细节。
 *
 * 时间纪律：state TTL 用 performance.now()（单调时钟，login-state-store）；
 * 本模块仅 webhook timestamp 窗口判定用墙钟（R1 allowlist：WEBHOOK_TIMESTAMP_WINDOW）。
 */

export function computeWechatSignature(input: { token: string; timestamp: string; nonce: string }): string {
  return createHash('sha1')
    .update([input.token, input.timestamp, input.nonce].sort().join(''))
    .digest('hex');
}

/** 验签：长度一致 + timingSafeEqual（防时序侧信道）。 */
export function verifyWechatSignature(input: {
  token: string;
  timestamp: string;
  nonce: string;
  signature: string;
}): boolean {
  const expected = computeWechatSignature({
    token: input.token,
    timestamp: input.timestamp,
    nonce: input.nonce,
  });
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(input.signature, 'utf8');
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

/** 微信 timestamp：秒（≤10 位）或毫秒（13 位）自动识别；非法返回 null。 */
export function parseWechatTimestampMs(value: string): number | null {
  if (!/^\d{1,13}$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

/** timestamp 窗口判定（±windowMs，防重放时间窗）。 */
export function isTimestampWithinWindow(timestampMs: number, nowMs: number, windowMs: number): boolean {
  return Math.abs(nowMs - timestampMs) <= windowMs;
}

/** 墙钟（webhook timestamp 窗口判定用；R1 时间纪律 allowlist 登记：WEBHOOK_TIMESTAMP_WINDOW）。 */
export function wallClockNowMs(): number {
  return Date.now();
}
