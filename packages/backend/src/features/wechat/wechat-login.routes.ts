import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimited, type CommonError } from '@teacher-platform/contracts';
import type { TokenAuthService } from '../../shared/http-auth/index.js';
import {
  createRequireAuth,
  parseSessionToken,
  type AuthenticatedRequest,
} from '../../shared/http-auth/index.js';
import { createSlidingWindowLimiter, type RateLimiter } from '../../shared/rate-limit/index.js';
import { createUnavailableCodeExchanger } from './code-exchanger.js';
import { isIpAllowed } from './ip-whitelist.js';
import {
  isTimestampWithinWindow,
  parseWechatTimestampMs,
  verifyWechatSignature,
  wallClockNowMs,
} from './signature.js';
import {
  WECHAT_PLATFORM,
  type ChannelIdentityDto,
  type ChannelIdentityService,
  type CodeExchanger,
  type LoginStateStore,
  type WechatIlinkConfig,
} from './types.js';

/**
 * 微信扫码登录路由工厂（P8 t9，设计 p7-wechat-ilink-design.md §3/§6/§7）。
 *
 * 端点：
 * - GET  /auth/wechat/qrcode          生成一次性短 TTL state（已登录 session → teacherId 关联）
 * - POST /auth/wechat/callback        OAuth 式 code 交换（验签 + IP 白名单 + state 防 CSRF + 绑定决策树）
 * - GET  /auth/wechat/login/status    轮询扫码状态（pending / confirmed(needs_login) / bound / expired）
 * - POST /auth/wechat/bind            未登录扫码 → 现有登录后完成绑定（requireAuth）
 * - POST /auth/wechat/unbind          解绑 = 删除 ChannelIdentity 行（requireAuth，幂等）
 *
 * 安全：回调静默丢弃（accepted:false，不返回业务细节）；state 一次性状态机防重放；
 * 限流复用 RateLimiter（扫码 1min/20、回调 1min/60、绑定 1min/60，IP 键）。
 * 装配：本工厂由装配线挂载（index.ts 留 L9/后续装配任务），此处只做内部路由。
 */

export interface WechatLoginRouterOptions {
  authService: TokenAuthService;
  channelIdentityService: ChannelIdentityService;
  stateStore: LoginStateStore;
  config: WechatIlinkConfig;
  /** 限流器（测试注入独立实例；缺省工厂内新建，避免跨 app 计数污染）。 */
  limiter?: RateLimiter;
  /** code 交换器（测试注入假实现；缺省不可用实现）。 */
  codeExchanger?: CodeExchanger;
  /** 墙钟（timestamp 窗口判定；测试注入；缺省 wallClockNowMs）。 */
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

export function createWechatLoginRouter(options: WechatLoginRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(options.authService);
  const limiter = options.limiter ?? createSlidingWindowLimiter({ maxKeys: options.config.maxStateKeys });
  const codeExchanger = options.codeExchanger ?? createUnavailableCodeExchanger();
  const nowMs = options.nowMs ?? wallClockNowMs;
  const resolveRequestIp = options.resolveRequestIp ?? defaultRequestIp;

  function createIpRateLimit(prefix: string, perMin: number) {
    const windowMs = 60_000;
    return async function ipRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
      const ip = resolveRequestIp(req);
      if (ip === null) {
        next(); // 无 IP（mock/内部请求）容错，同 rate-limit 中间件纪律
        return;
      }
      const result = await limiter.check(`${prefix}:${ip}`, windowMs, perMin);
      if (!result.allowed) {
        sendRateLimited(res, result.retryAfterMs, '请求过于频繁，请稍后重试');
        return;
      }
      next();
    };
  }

  /** 已登录 session → teacherId（无/无效 session → undefined，扫码仍可用）。 */
  async function resolveTeacherIdFromSession(req: Request): Promise<string | undefined> {
    const token = parseSessionToken(req.headers.cookie);
    if (!token) return undefined;
    const result = await options.authService.validateToken(token);
    return result.ok ? result.value.teacherId : undefined;
  }

  /** 回调验签 + state 校验 + code 交换 + 绑定决策树；任一失败 → false（静默丢弃）。 */
  async function handleCallback(req: Request): Promise<boolean> {
    // 1. 回调 IP 白名单（fail-closed：空白名单全拒）
    const ip = resolveRequestIp(req);
    if (ip === null || !isIpAllowed(ip, options.config.allowedIps)) return false;

    // 2. 验签 + timestamp 窗口（body 优先，query 兜底）
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
    const state = read('state');
    const code = read('code');
    if (!timestamp || !nonce || !signature || !state || !code) return false;
    const timestampMs = parseWechatTimestampMs(timestamp);
    if (timestampMs === null || !isTimestampWithinWindow(timestampMs, nowMs(), options.config.timestampWindowMs)) {
      return false;
    }
    if (!verifyWechatSignature({ token: options.config.token, timestamp, nonce, signature })) return false;

    // 3. state 校验（防 CSRF）：一次性 pending state（重复回调 → 状态机拒绝）
    const loginState = options.stateStore.get(state);
    if (!loginState || loginState.status !== 'pending') return false;

    // 4. code 交换（服务端到服务端，不经过浏览器）
    const exchange = await codeExchanger.exchange({ code, state });
    if (!exchange.ok) return false;

    // 5. 绑定决策树：
    if (loginState.teacherId) {
      // 已登录发起 → 直接绑 ChannelIdentity
      const bindResult = await options.channelIdentityService.bind({
        teacherId: loginState.teacherId,
        platform: WECHAT_PLATFORM,
        externalUserId: exchange.value.externalUserId,
        providerChannelId: exchange.value.providerChannelId,
      });
      if (!bindResult.ok) return false;
      options.stateStore.markBound(state); // 一次性消费（防重放）
      return true;
    }
    // 未登录 → 暂存 externalUserId，等现有登录后 bind（无账号默认不自动注册）
    return options.stateStore.markConfirmed(state, {
      externalUserId: exchange.value.externalUserId,
      providerChannelId: exchange.value.providerChannelId,
    });
  }

  // GET /auth/wechat/qrcode → { state, qrContent(占位), expiresInMs, authenticated }
  router.get(
    '/auth/wechat/qrcode',
    createIpRateLimit('wechat:login', options.config.qrcodeRatePerMin),
    async (req, res) => {
      const teacherId = await resolveTeacherIdFromSession(req);
      const state = options.stateStore.create({ teacherId });
      if (state === null) {
        sendError(res, 503, { code: 'INTERNAL_ERROR', message: '登录扫码请求过多，请稍后重试' });
        return;
      }
      // 二维码内容占位：真实 iLink 二维码 URL 在 W0 协议冻结后由供应商文档给出（须带 state 回传）
      const qrContent = `${options.config.apiBaseUrl}/scan?state=${encodeURIComponent(state)}`;
      res.status(200).json({
        ok: true,
        data: { state, qrContent, expiresInMs: options.config.stateTtlMs, authenticated: Boolean(teacherId) },
      });
    },
  );

  // POST /auth/wechat/callback → 200 { ok, data: { accepted } }（静默丢弃语义）
  router.post(
    '/auth/wechat/callback',
    createIpRateLimit('wechat:callback', options.config.callbackRatePerMin),
    async (req, res) => {
      const accepted = await handleCallback(req);
      res.status(200).json({ ok: true, data: { accepted } });
    },
  );

  // GET /auth/wechat/login/status?state= → 轮询状态
  router.get(
    '/auth/wechat/login/status',
    createIpRateLimit('wechat:login', options.config.qrcodeRatePerMin),
    (req, res) => {
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      if (!state) {
        sendError(res, 400, { code: 'VALIDATION_ERROR', message: '缺少 state 参数', field: 'state' });
        return;
      }
      const loginState = options.stateStore.get(state);
      if (!loginState) {
        res.status(200).json({ ok: true, data: { status: 'expired', binding: 'none' } });
        return;
      }
      if (loginState.status === 'bound') {
        res.status(200).json({ ok: true, data: { status: 'bound', binding: 'bound' } });
        return;
      }
      if (loginState.status === 'confirmed') {
        res.status(200).json({ ok: true, data: { status: 'confirmed', binding: 'needs_login' } });
        return;
      }
      res.status(200).json({ ok: true, data: { status: 'pending', binding: 'none' } });
    },
  );

  // POST /auth/wechat/bind（未登录扫码 → 登录后完成绑定；requireAuth）
  router.post(
    '/auth/wechat/bind',
    requireAuth,
    createIpRateLimit('wechat:bind', options.config.bindRatePerMin),
    async (req: AuthenticatedRequest, res) => {
      if (!req.teacherId) {
        sendError(res, 401, { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const state = typeof body.state === 'string' ? body.state : undefined;
      if (!state) {
        sendError(res, 400, { code: 'VALIDATION_ERROR', message: '缺少 state 参数', field: 'state' });
        return;
      }
      const loginState = options.stateStore.get(state);
      if (!loginState || loginState.status !== 'confirmed' || !loginState.externalUserId) {
        sendError(res, 409, { code: 'VALIDATION_ERROR', message: '请先完成微信扫码确认', field: 'state' });
        return;
      }
      const bindResult = await options.channelIdentityService.bind({
        teacherId: req.teacherId,
        platform: WECHAT_PLATFORM,
        externalUserId: loginState.externalUserId,
        providerChannelId: loginState.providerChannelId,
      });
      if (!bindResult.ok) {
        sendError(res, bindResult.error.code === 'VALIDATION_ERROR' ? 400 : 500, bindResult.error);
        return;
      }
      options.stateStore.markBound(state); // 一次性消费（防 state 重放）
      res.status(200).json({ ok: true, data: { bound: true, identity: toPublicIdentity(bindResult.value) } });
    },
  );

  // POST /auth/wechat/unbind（解绑 = 删除 ChannelIdentity 行；幂等）
  router.post(
    '/auth/wechat/unbind',
    requireAuth,
    createIpRateLimit('wechat:bind', options.config.bindRatePerMin),
    async (req: AuthenticatedRequest, res) => {
      if (!req.teacherId) {
        sendError(res, 401, { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' });
        return;
      }
      const result = await options.channelIdentityService.unbind({
        teacherId: req.teacherId,
        platform: WECHAT_PLATFORM,
      });
      if (!result.ok) {
        sendError(res, 500, result.error);
        return;
      }
      res.status(200).json({ ok: true, data: { unbound: result.value.unbound } });
    },
  );

  return router;
}

function toPublicIdentity(dto: ChannelIdentityDto): {
  platform: string;
  externalUserId: string;
  providerChannelId: string | null;
} {
  return {
    platform: dto.platform,
    externalUserId: dto.externalUserId,
    providerChannelId: dto.providerChannelId,
  };
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
