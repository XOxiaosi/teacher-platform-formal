import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimited, type CommonError } from '@teacher-platform/contracts';
import { createSlidingWindowLimiter, type RateLimiter } from '../../shared/rate-limit/index.js';
import { isIpAllowed } from './ip-whitelist.js';
import { parseWechatInboundPayload } from './provider-driver.js';
import {
  isTimestampWithinWindow,
  parseWechatTimestampMs,
  verifyWechatSignature,
  wallClockNowMs,
} from './signature.js';
import type { InboundMessageService, WechatIlinkConfig } from './types.js';

/**
 * 微信入站消息 webhook 路由（P8 t13，设计 p7-wechat-ilink-design.md §4）。
 *
 * POST /api/v1/wechat/message：
 * - 校验链：IP 限流 → IP 白名单（fail-closed）→ timestamp ±window → 验签
 *   （sha1(token/timestamp/nonce)，timingSafeEqual）→ 单用户入站限流（1min/10）→ 解析 → claim/入队；
 * - 5s 内 200 硬约束：路由只做 claim（1 次 insert）+ 入队（内存），不做 Agent/重活；
 * - 失败语义：验签/白名单失败静默 accepted:false（不返回业务细节）；队列满 → 503（供应商重试，持久幂等兜底）；
 * - 重投：同一 externalMessageId → 200 accepted:true + duplicate:true（不重复落行）。
 * 装配：由装配线挂载（index.ts 留后续），此处只做内部路由。
 */

export interface WechatMessageRouterOptions {
  config: WechatIlinkConfig;
  inboundService: InboundMessageService;
  /** 限流器（测试注入独立实例；缺省工厂内新建）。 */
  limiter?: RateLimiter;
  /** 墙钟（timestamp 窗口；测试注入；缺省 wallClockNowMs）。 */
  nowMs?: () => number;
  /** 请求 IP 解析（测试注入模拟非白名单 IP；缺省 req.ip）。 */
  resolveRequestIp?: (req: Request) => string | null;
}

function sendError(res: Response, status: number, error: CommonError): void {
  res.status(status).json({ ok: false, error });
}

function sendRateLimited(res: Response, retryAfterMs: number, message: string): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({ ok: false, error: rateLimited(message) });
}

export function createWechatMessageRouter(options: WechatMessageRouterOptions): Router {
  const router = Router();
  const limiter = options.limiter ?? createSlidingWindowLimiter({ maxKeys: 100_000 });
  const nowMs = options.nowMs ?? wallClockNowMs;
  const resolveRequestIp = options.resolveRequestIp ?? defaultRequestIp;

  /** 回调 IP 限流（设计 §7：webhook IP 1min/60）。 */
  async function ipRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ip = resolveRequestIp(req);
    if (ip === null) {
      next();
      return;
    }
    const result = await limiter.check(`wechat:webhook:${ip}`, 60_000, options.config.callbackRatePerMin);
    if (!result.allowed) {
      sendRateLimited(res, result.retryAfterMs, '请求过于频繁，请稍后重试');
      return;
    }
    next();
  }

  router.post('/wechat/message', ipRateLimit, async (req, res) => {
    // S5 超时保护：webhook 5s 硬约束（微信要求）——处理超时（默认 4s）即 503 背压，供应商重试、幂等键兜底
    const outcome = await withDeadline(handleWebhook(req), options.config.webhookTimeoutMs);
    if (outcome === 'timeout') {
      sendError(res, 503, { code: 'INTERNAL_ERROR', message: '处理超时，请稍后重试' });
      return;
    }
    if (outcome.kind === 'accepted') {
      res.status(200).json({
        ok: true,
        data: { accepted: true, duplicate: outcome.duplicate },
      });
      return;
    }
    if (outcome.kind === 'silent') {
      // 验签/白名单/格式失败：静默丢弃（不返回业务细节）
      res.status(200).json({ ok: true, data: { accepted: false } });
      return;
    }
    if (outcome.kind === 'rate_limited') {
      sendRateLimited(res, outcome.retryAfterMs, '消息发送过于频繁，请稍后重试');
      return;
    }
    sendError(res, 503, outcome.error); // 队列满/存储失败：供应商重试，持久幂等兜底
  });

  async function handleWebhook(req: Request): Promise<
    | { kind: 'accepted'; duplicate: boolean }
    | { kind: 'silent' }
    | { kind: 'rate_limited'; retryAfterMs: number }
    | { kind: 'error'; error: CommonError }
  > {
    // 1. IP 白名单（fail-closed：空白名单全拒）
    const ip = resolveRequestIp(req);
    if (ip === null || !isIpAllowed(ip, options.config.allowedIps)) return { kind: 'silent' };

    // 2. timestamp 窗口 + 验签（body 优先，query 兜底）
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const read = (key: string): string | undefined => {
      const fromBody = body[key];
      if (typeof fromBody === 'string') return fromBody;
      const fromQuery = query[key];
      if (typeof fromQuery === 'string') return fromQuery;
      if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') return fromQuery[0];
      return undefined;
    };
    const timestamp = read('timestamp');
    const nonce = read('nonce');
    const signature = read('signature');
    if (!timestamp || !nonce || !signature) return { kind: 'silent' };
    const timestampMs = parseWechatTimestampMs(timestamp);
    if (timestampMs === null || !isTimestampWithinWindow(timestampMs, nowMs(), options.config.timestampWindowMs)) {
      return { kind: 'silent' };
    }
    if (!verifyWechatSignature({ token: options.config.token, timestamp, nonce, signature })) {
      return { kind: 'silent' };
    }

    // 3. 单用户入站限流（验签通过后才计费，防伪造刷屏）
    const from = typeof body.fromExternalUserId === 'string' ? body.fromExternalUserId : undefined;
    if (from) {
      const limitResult = await limiter.check(`wechat:inbound:${from}`, 60_000, options.config.inboundPerMin);
      if (!limitResult.allowed) {
        return { kind: 'rate_limited', retryAfterMs: limitResult.retryAfterMs };
      }
    }

    // 4. 解析 → claim/入队（5s 内 200 硬约束：不做 Agent/重活）
    const parsed = parseWechatInboundPayload(body);
    if (!parsed.ok) return { kind: 'silent' };
    const result = await options.inboundService.receiveWebhook(parsed.value);
    if (!result.ok) return { kind: 'error', error: result.error };
    return { kind: 'accepted', duplicate: result.value.duplicate };
  }

  return router;
}

function defaultRequestIp(req: Request): string | null {
  let ip: string;
  try {
    ip = req.ip ?? '';
  } catch {
    return null;
  }
  if (!ip || ip === 'unknown') return null;
  return ip;
}

/** 带截止时间的结果（S5 超时保护）：超时/异常 → 'timeout'；正常 → 原值。unref 定时器不阻塞退出。 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout' as const);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve('timeout' as const);
      },
    );
  });
}
