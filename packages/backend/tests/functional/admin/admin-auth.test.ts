import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createAdminAuthService,
  createAdminAuthServiceFromEnv,
  hashAdminPassword,
  createAdminRouter,
} from '../../../src/features/admin/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import type { AuthService } from '../../../src/features/auth/index.js';
import { permissionDenied } from '@teacher-platform/contracts';

/**
 * 后台管理员认证（P7 渠道线 A2）单测：
 * - 登录成功/密码错 401/5 次失败锁定 429（键含 IP 维度，R7 纪律）
 * - adminToken 与 sessionToken 互斥（教师 token 访问 admin 路由 401、admin token 访问教师路由 401）
 * - logout 幂等、me 返回 {email} 无敏感字段
 * - env 缺失启动抛错；会话过期（单调时钟）
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

function createAdminApp(options: {
  sessionTtlMs?: number;
  failLimit?: number;
  emailGlobalLimit?: number;
} = {}) {
  const authService = createAdminAuthService({
    email: ADMIN_EMAIL,
    passwordHash: ADMIN_HASH,
    sessionTtlMs: options.sessionTtlMs,
  });
  const limiter = createSlidingWindowLimiter();
  const adminRouter = createAdminRouter({
    authService,
    loginLimiter: limiter,
    loginLockoutConfig: {
      failLimit: options.failLimit ?? 5,
      lockoutMs: 15 * 60 * 1000,
      emailGlobalLimit: options.emailGlobalLimit ?? 0,
    },
    // 教师总览依赖（本测试不触达 /teachers；空 stub 满足类型与路由装配）
    registryPrisma: {
      teacherRegistry: {
        findMany: async () => [],
        count: async () => 0,
        findUnique: async () => null,
      },
    } as never,
    pool: {
      acquire: async () => { throw new Error('not used in auth tests'); },
      release: () => undefined,
    } as never,
  });

  // 教师路由（stub：任何 sessionToken 校验失败 → 非生产无 x-teacher-id → 401）
  const stubAuth = {
    register: async () => ({ ok: false as const, error: permissionDenied('x') }),
    login: async () => ({ ok: false as const, error: permissionDenied('x') }),
    logout: async () => ({ ok: true as const, value: { ok: true as const } }),
    getMe: async () => ({ ok: false as const, error: permissionDenied('x') }),
    validateToken: async () => ({ ok: false as const, error: permissionDenied('x') }),
  } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1', createAuthRouter(stubAuth));
  return app;
}

function wrongPasswordAttempts(count: number) {
  return Array.from({ length: count }, () => ({
    email: ADMIN_EMAIL,
    password: 'wrong-password-xxx',
  }));
}

describe('admin auth: 登录', () => {
  it('登录成功：200 + Set-Cookie adminToken（HttpOnly;SameSite=Lax;Path=/api/v1/admin，非生产无 Secure）+ {email}', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { email: ADMIN_EMAIL } });
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie).toBeDefined();
    const cookie = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    expect(cookie).toContain('adminToken=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1/admin');
    expect(cookie).not.toContain('Secure'); // 非生产
  });

  it('密码错误 → 401 PERMISSION_DENIED（统一错误防枚举）', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-password-xxx' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('非管理员邮箱 → 同一 401（防枚举）', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'nobody@example.com', password: ADMIN_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('邮箱或密码错误');
  });

  it('body 缺字段 → 400 VALIDATION_ERROR', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('5 次失败 → 第 5 次起 429 RATE_LIMITED + Retry-After（键含 IP 维度）', async () => {
    const app = createAdminApp();
    for (const attempt of wrongPasswordAttempts(4)) {
      const res = await request(app).post('/api/v1/admin/auth/login').send(attempt);
      expect(res.status).toBe(401);
    }
    // 第 5 次失败触发锁定（failCount 达 failLimit）→ 429 + Retry-After
    const locked = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-password-xxx' });
    expect(locked.status).toBe(429);
    expect(locked.body.ok).toBe(false);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // 锁定期间正确密码也 429（锁定优先）
    const correctDuringLock = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(correctDuringLock.status).toBe(429);
  });

  it('成功登录清零失败计数（锁定不残留）', async () => {
    const app = createAdminApp();
    for (const attempt of wrongPasswordAttempts(4)) {
      await request(app).post('/api/v1/admin/auth/login').send(attempt);
    }
    // 第 5 次失败前用正确密码登录成功 → 计数清零
    const ok = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    // 再错 5 次仍从零计数：前 4 次 401，第 5 次才 429
    for (const attempt of wrongPasswordAttempts(4)) {
      const res = await request(app).post('/api/v1/admin/auth/login').send(attempt);
      expect(res.status).toBe(401);
    }
    const fifth = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-password-xxx' });
    expect(fifth.status).toBe(429);
  });
});

describe('admin auth: me / 互斥 / logout', () => {
  it('me：有效 adminToken → 200 {email}（无敏感字段）', async () => {
    const app = createAdminApp();
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const me = await agent.get('/api/v1/admin/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ ok: true, data: { email: ADMIN_EMAIL } });
    expect(me.body.data).not.toHaveProperty('passwordHash');
  });

  it('me：无 cookie → 401；无效 adminToken → 401', async () => {
    const app = createAdminApp();
    const noCookie = await request(app).get('/api/v1/admin/auth/me');
    expect(noCookie.status).toBe(401);

    const invalid = await request(app)
      .get('/api/v1/admin/auth/me')
      .set('Cookie', 'adminToken=definitely-invalid');
    expect(invalid.status).toBe(401);
  });

  it('互斥：教师 sessionToken 访问 admin 路由 → 401', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .get('/api/v1/admin/auth/me')
      .set('Cookie', 'sessionToken=teacher-session-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('互斥：adminToken 访问教师路由 /api/v1/auth/me → 401', async () => {
    const app = createAdminApp();
    const agent = request.agent(app);
    await agent
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(401);
  });

  it('logout 幂等：带/不带 cookie → 200；登出后 me → 401', async () => {
    const app = createAdminApp();
    const agent = request.agent(app);
    await agent
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    const logout = await agent.post('/api/v1/admin/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true, data: { ok: true } });

    const meAfter = await agent.get('/api/v1/admin/auth/me');
    expect(meAfter.status).toBe(401);

    // 无 cookie 再次登出仍 200
    const again = await request(app).post('/api/v1/admin/auth/logout');
    expect(again.status).toBe(200);
  });
});

describe('admin auth: 服务边界', () => {
  it('env 缺失（ADMIN_EMAIL/ADMIN_PASSWORD_HASH）→ 启动即抛错', () => {
    expect(() => createAdminAuthServiceFromEnv({} as NodeJS.ProcessEnv)).toThrow('ADMIN_EMAIL');
    expect(() =>
      createAdminAuthServiceFromEnv({ ADMIN_EMAIL: ADMIN_EMAIL } as NodeJS.ProcessEnv),
    ).toThrow('ADMIN_PASSWORD_HASH');
  });

  it('env 齐备 → 正常构建', () => {
    const service = createAdminAuthServiceFromEnv({
      ADMIN_EMAIL: ADMIN_EMAIL,
      ADMIN_PASSWORD_HASH: ADMIN_HASH,
    } as NodeJS.ProcessEnv);
    expect(service).toBeDefined();
  });

  it('非法邮箱/哈希格式 → 构建抛错', () => {
    expect(() =>
      createAdminAuthService({ email: 'not-an-email', passwordHash: ADMIN_HASH }),
    ).toThrow('ADMIN_EMAIL');
    expect(() =>
      createAdminAuthService({ email: ADMIN_EMAIL, passwordHash: 'plain-text' }),
    ).toThrow('ADMIN_PASSWORD_HASH');
  });

  it('会话过期（单调时钟）：短 TTL 后 me → 401', async () => {
    const app = createAdminApp({ sessionTtlMs: 80 });
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const before = await agent.get('/api/v1/admin/auth/me');
    expect(before.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await agent.get('/api/v1/admin/auth/me');
    expect(after.status).toBe(401);
  });
});
