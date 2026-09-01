import type { NextFunction, Request, Response } from 'express';
import { rateLimited } from '@teacher-platform/contracts';
import type { RateLimiter } from '../rate-limit/index.js';

export interface LoginLockoutConfig {
  failLimit: number;
  lockoutMs: number;
  emailGlobalLimit: number;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseLoginLockoutEnv(env: NodeJS.ProcessEnv = process.env): LoginLockoutConfig {
  return {
    failLimit: parsePositiveIntEnv(env.LOGIN_FAIL_LIMIT, 5),
    lockoutMs: parsePositiveIntEnv(env.LOGIN_LOCKOUT_MS, 15 * 60 * 1000),
    emailGlobalLimit: parsePositiveIntEnv(env.LOGIN_EMAIL_GLOBAL_LIMIT, 20),
  };
}

function resolveRequestIp(req: Request): string | null {
  let ip: string;
  try {
    ip = req.ip ?? '';
  } catch {
    return null;
  }
  return !ip || ip === 'unknown' ? null : ip;
}

function sendRateLimited(res: Response, retryAfterMs: number): void {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  res.status(429).json({ ok: false, error: rateLimited('多次失败已锁定，请稍后重试') });
}

export function createLoginLockoutMiddleware(options: {
  limiter: RateLimiter;
  config?: LoginLockoutConfig;
  key?: (req: Request, email: string) => string;
}) {
  const config = options.config ?? parseLoginLockoutEnv();
  return function loginLockoutMiddleware(req: Request, res: Response, next: NextFunction): void {
    const body = (req.body ?? {}) as { email?: unknown };
    if (typeof body.email !== 'string') {
      next();
      return;
    }
    const normalized = body.email.trim().toLowerCase();
    const ip = resolveRequestIp(req);
    const primary = options.key
      ? options.key(req, body.email)
      : ip === null ? `login:${normalized}` : `login:${ip}:${normalized}`;
    const global = options.key || config.emailGlobalLimit <= 0 ? null : `login:global:${normalized}`;
    const globalLocked = global ? options.limiter.isLocked(global) : { locked: false, retryAfterMs: 0 };
    if (globalLocked.locked) {
      sendRateLimited(res, globalLocked.retryAfterMs);
      return;
    }
    const primaryLocked = options.limiter.isLocked(primary);
    if (primaryLocked.locked) {
      sendRateLimited(res, primaryLocked.retryAfterMs);
      return;
    }
    (res.locals as Record<string, unknown>).loginLockKeys = { primary, global };
    (res.locals as Record<string, unknown>).loginLimiter = options.limiter;
    (res.locals as Record<string, unknown>).loginLockoutConfig = config;
    next();
  };
}

export function recordLoginResult(res: Response, success: boolean): { locked: boolean; retryAfterMs: number } {
  const keys = (res.locals as Record<string, unknown>).loginLockKeys as
    | { primary: string; global: string | null }
    | undefined;
  const limiter = (res.locals as Record<string, unknown>).loginLimiter as RateLimiter | undefined;
  const config = (res.locals as Record<string, unknown>).loginLockoutConfig as LoginLockoutConfig | undefined;
  if (!keys || !limiter) return { locked: false, retryAfterMs: 0 };
  if (success) {
    limiter.recordSuccess(keys.primary);
    if (keys.global) limiter.recordSuccess(keys.global);
    return { locked: false, retryAfterMs: 0 };
  }
  const failLimit = config?.failLimit ?? 5;
  const lockoutMs = config?.lockoutMs ?? 15 * 60 * 1000;
  if (keys.global && config && config.emailGlobalLimit > 0) {
    const globalResult = limiter.recordFailure(keys.global, { failLimit: config.emailGlobalLimit, lockoutMs });
    if (globalResult.locked) return globalResult;
  }
  return limiter.recordFailure(keys.primary, { failLimit, lockoutMs });
}
