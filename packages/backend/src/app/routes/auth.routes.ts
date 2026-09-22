import { Router } from 'express';
import type { Response } from 'express';
import { validationError, type CommonError } from '@teacher-platform/contracts';
import type { AuthService } from '../../features/auth/index.js';
import {
  createRequireAuth,
  parseSessionToken,
  type AuthenticatedRequest,
} from '../middleware/require-auth.js';
import {
  createLoginLockoutMiddleware,
  createRegisterRateLimitMiddleware,
  recordLoginResult,
  type RateLimiter,
  type RegisterRateLimitConfig,
} from '../middleware/rate-limit.js';

const SESSION_COOKIE_NAME = 'sessionToken';

/** 生产强制 Secure（P1，t38 §1.5）：仅 NODE_ENV=production 追加；dev http 不加（本机登录可用）。 */
function secureAttribute(): string {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

/** 会话 cookie：HttpOnly; SameSite=Lax; Path=/（不暴露给 JS，防 XSS 读取）。 */
function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/${secureAttribute()}`,
  );
}

/** 清空会话 cookie（登出）。 */
function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttribute()}`,
  );
}

/**
 * 认证错误 → HTTP 状态码。
 * 认证语义：凭据/会话失败统一 401（区别于业务 403）；校验 400；不存在 404。
 */
function statusFromAuthError(error: CommonError): number {
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'NOT_FOUND') return 404;
  return 500;
}

function sendAuthError(res: Response, error: CommonError): void {
  res.status(statusFromAuthError(error)).json({ ok: false, error });
}

function readStringBody(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export interface AuthRouterOptions {
  /** 登录失败锁定限流器（P1，t38 §2.4）；缺省不启用锁定（向后兼容） */
  loginLimiter?: RateLimiter;
  /** 邀请接受限流器（沿用旧配置名，避免装配层失配）；缺省不启用（直连路由测试可注入）。 */
  registerLimiter?: RateLimiter;
  /** 邀请接受限流配置（配置名沿用既有环境变量，避免无关迁移）。 */
  registerLimitConfig?: RegisterRateLimitConfig;
}

export function createAuthRouter(authService: AuthService, options: AuthRouterOptions = {}): Router {
  const router = Router();
  const requireAuth = createRequireAuth(authService);
  const loginLockout = options.loginLimiter
    ? createLoginLockoutMiddleware({ limiter: options.loginLimiter })
    : null;
  // 邀请接受限流中间件（handler 之前：成功/失败请求一律计数）；缺省不启用。
  const invitationAcceptLimit = options.registerLimiter
    ? createRegisterRateLimitMiddleware({
        limiter: options.registerLimiter,
        ...(options.registerLimitConfig ? { config: options.registerLimitConfig } : {}),
      })
    : null;

  // 公开自注册显式 404：阻断后续业务 guard 把未命中请求改写为 401；这里不调用任何认证服务。
  router.post('/auth/register', (_req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '资源不存在' } });
  });

  // POST /api/v1/auth/invitations/accept → 201 + Set-Cookie sessionToken
  router.post('/auth/invitations/accept', invitationAcceptLimit ?? ((_req, _res, next) => next()), async (req, res) => {
    const token = readStringBody(req.body, 'token');
    const password = readStringBody(req.body, 'password');
    const displayName = readStringBody(req.body, 'displayName');
    if (token === undefined || password === undefined || displayName === undefined) {
      sendAuthError(res, validationError('请求体必须包含 token/password/displayName', 'body'));
      return;
    }
    const result = await authService.acceptInvitation({ token, password, displayName });
    if (!result.ok) {
      sendAuthError(res, result.error);
      return;
    }
    setSessionCookie(res, result.value.token);
    res.status(201).json({
      ok: true,
      data: { teacher: result.value.teacher, expiresAtTs: result.value.expiresAtTs },
    });
  });

  // POST /api/v1/auth/login → 200 + Set-Cookie sessionToken（5 次失败锁定 15 分钟）
  router.post('/auth/login', loginLockout ?? ((_req, _res, next) => next()), async (req, res) => {
    const email = readStringBody(req.body, 'email');
    const password = readStringBody(req.body, 'password');
    if (email === undefined || password === undefined) {
      sendAuthError(res, validationError('请求体必须包含 email/password', 'body'));
      return;
    }
    const result = await authService.login({ email, password });
    if (!result.ok) {
      // 登录失败：计数（达 5 次锁 15 分钟，响应 429 + Retry-After；未锁定保持 401）
      const locked = recordLoginResult(res, false);
      if (locked.locked) {
        const retryAfterSeconds = Math.max(1, Math.ceil(locked.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
          ok: false,
          error: { code: 'RATE_LIMITED', message: '多次失败已锁定，请稍后重试', field: 'rate' },
        });
        return;
      }
      sendAuthError(res, result.error);
      return;
    }
    recordLoginResult(res, true);
    setSessionCookie(res, result.value.token);
    res.status(200).json({
      ok: true,
      data: { teacher: result.value.teacher, expiresAtTs: result.value.expiresAtTs },
    });
  });

  // POST /api/v1/auth/logout → 清 cookie + 删 session，幂等 200
  router.post('/auth/logout', async (req, res) => {
    const token = parseSessionToken(req.headers.cookie);
    if (token) {
      await authService.logout(token);
    }
    clearSessionCookie(res);
    res.status(200).json({ ok: true, data: { ok: true } });
  });

  // GET /api/v1/auth/me → 200 公开信息 | 401（requireAuth 兜底）
  router.get('/auth/me', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendAuthError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await authService.getMe(req.teacherId);
    if (!result.ok) {
      sendAuthError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  return router;
}
