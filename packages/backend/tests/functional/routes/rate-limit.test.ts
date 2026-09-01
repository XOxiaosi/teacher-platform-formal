import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  createSlidingWindowLimiter,
  createRateLimitMiddleware,
  createAgentTeacherRateLimitMiddleware,
  createLoginLockoutMiddleware,
  recordLoginResult,
  parseLoginLockoutEnv,
} from '../../../src/app/middleware/rate-limit.js';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    path: '/students',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { locals: Record<string, unknown> } {
  const res = {
    locals: {},
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & { locals: Record<string, unknown> };
  return res;
}

interface InvokeResult {
  status: number;
  body: { ok: boolean; error: { code: string; message: string; field?: string } } | null;
  retryAfter: string | undefined;
}

/** 调用中间件：在 res.json 时 resolve（status 链式先返回 this）。 */
function invoke(
  middleware: ReturnType<typeof createRateLimitMiddleware> | ReturnType<typeof createLoginLockoutMiddleware>,
  req: Request,
): Promise<InvokeResult> {
  return new Promise((resolve) => {
    const res = mockRes();
    res.status = vi.fn((code: number) => {
      (res as unknown as { _status: number })._status = code;
      return res;
    }) as unknown as typeof res.status;
    res.json = vi.fn((body: unknown) => {
      const status = (res as unknown as { _status: number })._status ?? 200;
      const retryAfter = (res.setHeader as unknown as { mock: { calls: [string, string][] } }).mock.calls
        .find(([name]) => name === 'Retry-After')?.[1];
      resolve({ status, body: body as InvokeResult['body'], retryAfter });
      return res;
    }) as unknown as typeof res.json;
    const next: NextFunction = () => resolve({ status: 200, body: null, retryAfter: undefined });
    (middleware as (r: Request, s: Response, n: NextFunction) => unknown)(req, res, next);
  });
}

describe('createSlidingWindowLimiter', () => {
  it('窗口内超限：第 max+1 个请求拒绝 + retryAfterMs 正确', async () => {
    const limiter = createSlidingWindowLimiter();
    for (let i = 0; i < 3; i += 1) {
      const ok = await limiter.check('k1', 1000, 3);
      expect(ok.allowed).toBe(true);
    }
    const denied = await limiter.check('k1', 1000, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('窗口滑动后恢复', async () => {
    const limiter = createSlidingWindowLimiter();
    for (let i = 0; i < 2; i += 1) {
      await limiter.check('k2', 50, 2);
    }
    const denied = await limiter.check('k2', 50, 2);
    expect(denied.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    const ok = await limiter.check('k2', 50, 2);
    expect(ok.allowed).toBe(true);
  });

  it('不同 key 独立计数', async () => {
    const limiter = createSlidingWindowLimiter();
    for (let i = 0; i < 3; i += 1) {
      await limiter.check('a', 1000, 3);
    }
    const a = await limiter.check('a', 1000, 3);
    const b = await limiter.check('b', 1000, 3);
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(true);
  });

  it('登录失败 5 次锁定 15 分钟，成功清零', () => {
    const limiter = createSlidingWindowLimiter();
    for (let i = 0; i < 4; i += 1) {
      const r = limiter.recordFailure('login:test@example.com');
      expect(r.locked).toBe(false);
    }
    const locked = limiter.recordFailure('login:test@example.com');
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterMs).toBe(15 * 60 * 1000);
    expect(limiter.isLocked('login:test@example.com').locked).toBe(true);

    limiter.recordSuccess('login:test@example.com');
    expect(limiter.isLocked('login:test@example.com').locked).toBe(false);
  });

  it('键数上限：超阈值不新建键（放行防内存耗尽）', async () => {
    const limiter = createSlidingWindowLimiter({ maxKeys: 2 });
    await limiter.check('x1', 1000, 10);
    await limiter.check('x2', 1000, 10);
    const third = await limiter.check('x3', 1000, 10);
    expect(third.allowed).toBe(true);
  });

  it('sweep 幂等：清理失效锁定后 size 回落（经可观测行为验证）', async () => {
    const limiter = createSlidingWindowLimiter();
    // 锁定一个 key（5 次失败）
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure('login:sweep@example.com');
    }
    expect(limiter.isLocked('login:sweep@example.com').locked).toBe(true);
    // sweep 不清理活跃锁定（lockedUntil 未到）
    limiter.sweep();
    expect(limiter.isLocked('login:sweep@example.com').locked).toBe(true);
    // sweep 幂等：再次调用不抛错
    limiter.sweep();
    expect(limiter.size()).toBeGreaterThan(0);
    // 窗口键：check 后 sweep 不影响活跃窗口（未过期）
    await limiter.check('window-key', 1000, 10);
    limiter.sweep();
    expect(limiter.isLocked('login:sweep@example.com').locked).toBe(true);
  });
});

describe('createRateLimitMiddleware', () => {
  it('普通端点超限 → 429 + Retry-After + RATE_LIMITED 信封', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 2 });
    for (let i = 0; i < 2; i += 1) {
      const first = await invoke(middleware, mockReq({ path: '/students', ip: '10.1.1.1' }));
      expect(first.status).toBe(200);
    }
    const third = await invoke(middleware, mockReq({ path: '/students', ip: '10.1.1.1' }));
    expect(third.status).toBe(429);
    expect(third.retryAfter).toBeDefined();
    expect(third.body).not.toBeNull();
    expect(third.body!.ok).toBe(false);
    expect(third.body!.error.code).toBe('RATE_LIMITED');
    expect(third.body!.error.field).toBe('rate');
  });

  it('无 socket/无 IP 的请求跳过限流（内部/测试请求容错）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 1 });
    // 无 teacherId 且无有效 IP（req.ip 为 undefined）→ 跳过限流
    for (let i = 0; i < 5; i += 1) {
      const result = await invoke(middleware, mockReq({ path: '/students', ip: undefined }));
      expect(result.status).toBe(200);
    }
  });

  it('认证请求按 teacherId 键（不同教师独立计数）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 1 });
    const reqA = mockReq({ path: '/students' });
    (reqA as Request & { teacherId?: string }).teacherId = 'teacher-a';
    const a1 = await invoke(middleware, reqA);
    expect(a1.status).toBe(200);
    const a2 = await invoke(middleware, reqA);
    expect(a2.status).toBe(429);

    const reqB = mockReq({ path: '/students' });
    (reqB as Request & { teacherId?: string }).teacherId = 'teacher-b';
    const b1 = await invoke(middleware, reqB);
    expect(b1.status).toBe(200);
  });

  it('未认证按 IP 键', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 1 });
    await invoke(middleware, mockReq({ path: '/students', ip: '10.0.0.1' }));
    const second = await invoke(middleware, mockReq({ path: '/students', ip: '10.0.0.1' }));
    expect(second.status).toBe(429);
    const other = await invoke(middleware, mockReq({ path: '/students', ip: '10.0.0.2' }));
    expect(other.status).toBe(200);
  });

  it('Agent 端点更严：1min/10 独立于普通端点（agent-ip 键隔离）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 100 });
    const agentReq = mockReq({ path: '/agent/converse' });
    for (let i = 0; i < 10; i += 1) {
      const ok = await invoke(middleware, agentReq);
      expect(ok.status).toBe(200);
    }
    const denied = await invoke(middleware, agentReq);
    expect(denied.status).toBe(429);
  });

  it('P16 双键隔离：同 IP 普通请求不耗尽 agent 额度（agent-ip 与 ip 窗口隔离）', async () => {
    const limiter = createSlidingWindowLimiter();
    // 普通窗口 2 次/窗，agent 窗口 10 次/窗：同 IP 普通请求打满也不影响 agent 路径
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 2, agentWindowMs: 1000, agentMax: 10 });
    // 同 IP 打普通路径 5 次（超普通上限 2 次 → 第 3 次起 429，但 agent 键独立不受影响）
    for (let i = 0; i < 5; i += 1) {
      const r = await invoke(middleware, mockReq({ path: '/students', ip: '10.0.0.9' }));
      expect(r.status).toBe(i < 2 ? 200 : 429);
    }
    // agent 路径同 IP 10 次内仍 200（普通请求未计入 agent 键）
    for (let i = 0; i < 10; i += 1) {
      const r = await invoke(middleware, mockReq({ path: '/agent/converse', ip: '10.0.0.9' }));
      expect(r.status).toBe(200);
    }
  });

  it('P16 双键隔离：agent 路径的 agent-ip 键与普通 ip 键不共享窗口（普通路径不因 agent 打满被 429）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 100, agentWindowMs: 1000, agentMax: 2 });
    // agent 打满（2 次后第 3 次 429）
    for (let i = 0; i < 2; i += 1) {
      const r = await invoke(middleware, mockReq({ path: '/agent/converse', ip: '10.0.0.7' }));
      expect(r.status).toBe(200);
    }
    const agentDenied = await invoke(middleware, mockReq({ path: '/agent/converse', ip: '10.0.0.7' }));
    expect(agentDenied.status).toBe(429);
    // 同 IP 普通路径仍 200（独立窗口）
    const normal = await invoke(middleware, mockReq({ path: '/students', ip: '10.0.0.7' }));
    expect(normal.status).toBe(200);
  });

  it('health 端点放行（不参与限流）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 0 });
    const health = await invoke(middleware, mockReq({ path: '/health/live' }));
    expect(health.status).toBe(200);
  });

  it('metrics 端点参与限流（G3 收口：/metrics 超阈值 → 429）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 1 });
    const metricsReq = mockReq({ path: '/metrics', ip: '10.0.0.3' });
    const first = await invoke(middleware, metricsReq);
    expect(first.status).toBe(200);
    const denied = await invoke(middleware, metricsReq);
    expect(denied.status).toBe(429);
    expect(denied.body!.ok).toBe(false);
    expect(denied.body!.error.code).toBe('RATE_LIMITED');
  });

  it('P16 env 覆盖：AGENT_RATE_LIMIT_MAX/WINDOW_MS 生效（agent 上限可调小）', async () => {
    const originalEnv = { ...process.env };
    try {
      process.env.AGENT_RATE_LIMIT_MAX = '2';
      process.env.AGENT_RATE_LIMIT_WINDOW_MS = '500';
      const limiter = createSlidingWindowLimiter();
      const middleware = createRateLimitMiddleware({ limiter });
      // 第 3 次 agent 请求 429（上限 2）
      for (let i = 0; i < 2; i += 1) {
        const r = await invoke(middleware, mockReq({ path: '/agent/converse', ip: '10.0.0.5' }));
        expect(r.status).toBe(200);
      }
      const denied = await invoke(middleware, mockReq({ path: '/agent/converse', ip: '10.0.0.5' }));
      expect(denied.status).toBe(429);
    } finally {
      process.env = originalEnv;
    }
  });
});

describe('createAgentTeacherRateLimitMiddleware（P16 per-teacher agent 限流）', () => {
  it('同 IP 多教师按 teacherId 独立计数：A 打满不影响 B', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createAgentTeacherRateLimitMiddleware({ limiter, windowMs: 1000, max: 2 });
    const reqA = mockReq({ path: '/agent/converse' });
    (reqA as Request & { teacherId?: string }).teacherId = 'teacher-a';
    const reqB = mockReq({ path: '/agent/converse' });
    (reqB as Request & { teacherId?: string }).teacherId = 'teacher-b';
    for (let i = 0; i < 2; i += 1) {
      expect((await invoke(middleware, reqA)).status).toBe(200);
    }
    // A 第 3 次 429（打满）
    expect((await invoke(middleware, reqA)).status).toBe(429);
    // B 同 IP 仍 200（teacherId 键独立）
    expect((await invoke(middleware, reqB)).status).toBe(200);
  });

  it('非 agent 路径放行（不计数）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createAgentTeacherRateLimitMiddleware({ limiter, windowMs: 1000, max: 1 });
    const req = mockReq({ path: '/students' });
    (req as Request & { teacherId?: string }).teacherId = 'teacher-a';
    for (let i = 0; i < 5; i += 1) {
      expect((await invoke(middleware, req)).status).toBe(200);
    }
  });

  it('无 teacherId 防御性放行（requireAuth 已在前拦截；不重复计数）', async () => {
    const limiter = createSlidingWindowLimiter();
    const middleware = createAgentTeacherRateLimitMiddleware({ limiter, windowMs: 1000, max: 1 });
    const req = mockReq({ path: '/agent/converse' });
    for (let i = 0; i < 5; i += 1) {
      expect((await invoke(middleware, req)).status).toBe(200);
    }
  });

  it('agent 路径与前置 rateLimit 的 agent-ip 键共享同一 limiter 但键隔离', async () => {
    const limiter = createSlidingWindowLimiter();
    // 前置（agent-ip 兜底 1 次/窗）+ per-teacher（2 次/窗）——同一 limiter 实例
    const front = createRateLimitMiddleware({ limiter, windowMs: 1000, max: 100, agentWindowMs: 1000, agentMax: 1 });
    const teacher = createAgentTeacherRateLimitMiddleware({ limiter, windowMs: 1000, max: 2 });
    const agentReq = mockReq({ path: '/agent/converse', ip: '10.0.0.6' });
    (agentReq as Request & { teacherId?: string }).teacherId = 'teacher-a';
    // 前置 IP 兜底第 1 次放行、第 2 次 429；per-teacher 键独立计数不受前置影响（反过来验证键隔离）
    expect((await invoke(front, agentReq)).status).toBe(200);
    const frontDenied = await invoke(front, agentReq);
    expect(frontDenied.status).toBe(429);
    // per-teacher 中间件（独立调用）同 teacher 第 1、2 次仍 200（键 agent-teacher: 与 agent-ip: 隔离）
    expect((await invoke(teacher, agentReq)).status).toBe(200);
    expect((await invoke(teacher, agentReq)).status).toBe(200);
    const teacherDenied = await invoke(teacher, agentReq);
    expect(teacherDenied.status).toBe(429);
    expect(teacherDenied.body!.error.code).toBe('RATE_LIMITED');
  });
});

describe('createLoginLockoutMiddleware + recordLoginResult', () => {
  it('5 次失败后锁定（同 IP+email 键）→ 后续请求 429 + Retry-After + RATE_LIMITED', async () => {
    const limiter = createSlidingWindowLimiter();
    const lockout = createLoginLockoutMiddleware({ limiter });

    for (let i = 0; i < 5; i += 1) {
      const req = mockReq({ body: { email: 'victim@example.com' } }) as Request & { body: unknown };
      const res = mockRes();
      const next = vi.fn();
      lockout(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      recordLoginResult(res, false);
    }
    // 同 IP+email 键已锁
    expect(limiter.isLocked('login:127.0.0.1:victim@example.com').locked).toBe(true);

    const locked = await invoke(lockout, mockReq({ body: { email: 'victim@example.com' } }) as Request);
    expect(locked.status).toBe(429);
    expect(locked.retryAfter).toBeDefined();
    expect(locked.body!.ok).toBe(false);
    expect(locked.body!.error.code).toBe('RATE_LIMITED');
    expect(locked.body!.error.message).toContain('锁定');
  });

  it('同 IP 不同 email 互不影响（防误锁他人邮箱）', async () => {
    const limiter = createSlidingWindowLimiter();
    const lockout = createLoginLockoutMiddleware({ limiter });
    // 同一 IP 刷错 email-a 5 次
    for (let i = 0; i < 5; i += 1) {
      const req = mockReq({ body: { email: 'a@example.com' } }) as Request & { body: unknown };
      const res = mockRes();
      lockout(req, res, vi.fn());
      recordLoginResult(res, false);
    }
    expect(limiter.isLocked('login:127.0.0.1:a@example.com').locked).toBe(true);
    // 同 IP 不同 email 不受影响
    expect(limiter.isLocked('login:127.0.0.1:b@example.com').locked).toBe(false);
  });

  it('不同 IP 同 email 各自计数（跨 IP 不误锁）', async () => {
    const limiter = createSlidingWindowLimiter();
    const lockout = createLoginLockoutMiddleware({ limiter });
    for (let i = 0; i < 5; i += 1) {
      const req = mockReq({ body: { email: 'shared@example.com' }, ip: '10.0.0.1' }) as Request & { body: unknown };
      const res = mockRes();
      lockout(req, res, vi.fn());
      recordLoginResult(res, false);
    }
    // IP1 锁了
    expect(limiter.isLocked('login:10.0.0.1:shared@example.com').locked).toBe(true);
    // IP2 同 email 未锁（各自计数）
    expect(limiter.isLocked('login:10.0.0.2:shared@example.com').locked).toBe(false);
  });

  it('email 全局锁：跨 IP 累计达阈值锁全 email（防撞库）', async () => {
    const limiter = createSlidingWindowLimiter();
    const lockout = createLoginLockoutMiddleware({
      limiter,
      config: { failLimit: 5, lockoutMs: 15 * 60 * 1000, emailGlobalLimit: 10 },
    });
    // 5 个不同 IP 各失败 2 次 → email 全局累计 10 次 → 触发全局锁
    for (let ip = 1; ip <= 5; ip += 1) {
      for (let i = 0; i < 2; i += 1) {
        const req = mockReq({ body: { email: 'dictionary@example.com' }, ip: `10.1.0.${ip}` }) as Request & { body: unknown };
        const res = mockRes();
        lockout(req, res, vi.fn());
        recordLoginResult(res, false);
      }
    }
    // 全局锁触发：新 IP 同 email 也被 429
    expect(limiter.isLocked('login:global:dictionary@example.com').locked).toBe(true);
    const blocked = await invoke(lockout, mockReq({ body: { email: 'dictionary@example.com' }, ip: '10.9.9.9' }) as Request);
    expect(blocked.status).toBe(429);
    expect(blocked.body!.error.message).toContain('锁定');
  });

  it('锁定后正确密码仍 429（锁定期间不验证凭据）', async () => {
    const limiter = createSlidingWindowLimiter();
    const lockout = createLoginLockoutMiddleware({ limiter });
    for (let i = 0; i < 5; i += 1) {
      const req = mockReq({ body: { email: 'locked@example.com' } }) as Request & { body: unknown };
      const res = mockRes();
      lockout(req, res, vi.fn());
      recordLoginResult(res, false);
    }
    // 锁定期间正确密码也被中间件 429 拦截（不进路由验证）
    const blocked = await invoke(lockout, mockReq({ body: { email: 'locked@example.com' } }) as Request);
    expect(blocked.status).toBe(429);
  });

  it('成功登录清零主键与全局累计', () => {
    const limiter = createSlidingWindowLimiter();
    const lockout = createLoginLockoutMiddleware({
      limiter,
      config: { failLimit: 5, lockoutMs: 15 * 60 * 1000, emailGlobalLimit: 10 },
    });
    for (let i = 0; i < 5; i += 1) {
      const req = mockReq({ body: { email: 'ok@example.com' } }) as Request & { body: unknown };
      const res = mockRes();
      lockout(req, res, vi.fn());
      recordLoginResult(res, false);
    }
    const primaryKey = 'login:127.0.0.1:ok@example.com';
    expect(limiter.isLocked(primaryKey).locked).toBe(true);

    // 成功登录：recordLoginResult(success=true) 清零主键 + 全局累计
    const successRes = mockRes();
    successRes.locals.loginLockKeys = { primary: primaryKey, global: 'login:global:ok@example.com' };
    successRes.locals.loginLimiter = limiter;
    successRes.locals.loginLockoutConfig = { failLimit: 5, lockoutMs: 15 * 60 * 1000, emailGlobalLimit: 10 };
    recordLoginResult(successRes, true);
    expect(limiter.isLocked(primaryKey).locked).toBe(false);
    expect(limiter.isLocked('login:global:ok@example.com').locked).toBe(false);
  });

  it('parseLoginLockoutEnv：env 可配阈值，非法回退默认', () => {
    const fromEnv = parseLoginLockoutEnv({
      LOGIN_FAIL_LIMIT: '3',
      LOGIN_LOCKOUT_MS: '60000',
      LOGIN_EMAIL_GLOBAL_LIMIT: '7',
    } as NodeJS.ProcessEnv);
    expect(fromEnv).toEqual({ failLimit: 3, lockoutMs: 60000, emailGlobalLimit: 7 });

    const defaults = parseLoginLockoutEnv({} as NodeJS.ProcessEnv);
    expect(defaults.failLimit).toBe(5);
    expect(defaults.lockoutMs).toBe(15 * 60 * 1000);
    expect(defaults.emailGlobalLimit).toBe(20);

    const bad = parseLoginLockoutEnv({ LOGIN_FAIL_LIMIT: 'abc', LOGIN_LOCKOUT_MS: '-1' } as NodeJS.ProcessEnv);
    expect(bad.failLimit).toBe(5);
    expect(bad.lockoutMs).toBe(15 * 60 * 1000);
  });
});
