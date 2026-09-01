import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createSlidingWindowLimiter } from '../../src/app/middleware/rate-limit.js';

/**
 * 注册限流（P17 契约 t3/t4，reports/security/register-rate-limit-fix-contract.md §5 测试矩阵 M1–M5）：
 * - M1 限额内注册成功（默认 20/1h，env 默认值语义 M6 合并）
 * - M2 超限 429：精确信封 {ok:false,error:{code:'RATE_LIMITED',message:'注册请求过于频繁，请稍后重试',field:'rate'}} + Retry-After≥1 + 无 Set-Cookie
 * - M3 失败请求（400 校验失败）也计数（中间件在 handler 前）
 * - M4 键隔离：register:ip:* 与 login:* 互不影响（注册 429 后 login 仍 401）
 * - M5 429 请求不落库（TeacherRegistry/SessionStore 零写入）
 *
 * 纪律：随机邮箱、afterAll 清理 createdTeacherIds、无 Date.now 依赖（限流簿记走 performance.now）。
 */

const prisma = new PrismaClient();

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function uniqueEmail(prefix = 'reg-rate'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

function trackTeacher(data: { id: string }): void {
  createdTeacherIds.push(data.id);
}

/** 注册请求（中间件在 handler 前计数：成功/失败均计）。 */
function register(app: ReturnType<typeof createApp>, email: string, displayName = '限流测试') {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123', displayName });
}

// 小阈值注入：createApp 时 createAuthRouter 构建 register 中间件，parseRegisterRateLimitEnv
// 在构建时刻读 env（与 login lockout 同语义）；每个场景独立 env + 独立 app/limiter，互不污染。
const REGISTER_MAX_KEY = 'REGISTER_RATE_LIMIT_MAX';
const REGISTER_WINDOW_KEY = 'REGISTER_RATE_LIMIT_WINDOW_MS';
const originalMax = process.env[REGISTER_MAX_KEY];
const originalWindow = process.env[REGISTER_WINDOW_KEY];

function setRegisterEnv(max?: number, windowMs?: number): void {
  if (max === undefined) delete process.env[REGISTER_MAX_KEY];
  else process.env[REGISTER_MAX_KEY] = String(max);
  if (windowMs === undefined) delete process.env[REGISTER_WINDOW_KEY];
  else process.env[REGISTER_WINDOW_KEY] = String(windowMs);
}

afterEach(() => {
  setRegisterEnv(undefined, undefined);
});

afterAll(() => {
  if (originalMax === undefined) delete process.env[REGISTER_MAX_KEY];
  else process.env[REGISTER_MAX_KEY] = originalMax;
  if (originalWindow === undefined) delete process.env[REGISTER_WINDOW_KEY];
  else process.env[REGISTER_WINDOW_KEY] = originalWindow;
});

describe('register 限流：限额内（默认 20/1h，env 默认值语义 M6 合并）', () => {
  it('M1 连发 3 次不同邮箱注册 → 全部 201 + Set-Cookie（回归保护，与 auth-flow 同形态）', async () => {
    const app = createApp(prisma, { rateLimiter: createSlidingWindowLimiter() });
    for (let i = 0; i < 3; i += 1) {
      const res = await register(app, uniqueEmail());
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
      expect(setCookie).toBeDefined();
      expect(Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).toContain('sessionToken=');
      trackTeacher(res.body.data.teacher);
    }
  });
});

describe('register 限流：超限 429（注入 max=2, windowMs=3600000）', () => {
  it('M2 第 3 次注册（新邮箱）→ 429 + 精确信封 + Retry-After≥1 + 无 Set-Cookie', async () => {
    setRegisterEnv(2, 3600000);
    const app = createApp(prisma, { rateLimiter: createSlidingWindowLimiter() });

    const first = await register(app, uniqueEmail());
    expect(first.status).toBe(201);
    trackTeacher(first.body.data.teacher);

    const second = await register(app, uniqueEmail());
    expect(second.status).toBe(201);
    trackTeacher(second.body.data.teacher);

    const third = await register(app, uniqueEmail());
    expect(third.status).toBe(429);
    expect(third.body).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: '注册请求过于频繁，请稍后重试', field: 'rate' },
    });
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(third.headers['set-cookie']).toBeUndefined();
  });

  it('M3 失败请求也计数：max=1 先发缺字段请求（400）→ 再发合法注册 → 429（中间件在 handler 前）', async () => {
    setRegisterEnv(1, 3600000);
    const app = createApp(prisma, { rateLimiter: createSlidingWindowLimiter() });

    const invalid = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'password123' }); // 缺 displayName → 400
    expect(invalid.status).toBe(400);

    const valid = await register(app, uniqueEmail());
    expect(valid.status).toBe(429);
    expect(valid.body).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: '注册请求过于频繁，请稍后重试', field: 'rate' },
    });
  });

  it('M4 键隔离：注册被 429 后 login（任意凭据）→ 401 而非 429（register:ip:* 与 login:* 互不影响）', async () => {
    setRegisterEnv(1, 3600000);
    const app = createApp(prisma, { rateLimiter: createSlidingWindowLimiter() });

    const first = await register(app, uniqueEmail());
    expect(first.status).toBe(201);
    trackTeacher(first.body.data.teacher);

    const second = await register(app, uniqueEmail());
    expect(second.status).toBe(429);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'whatever123' });
    expect(login.status).toBe(401); // 未达登录锁定阈值（5 次失败），不受注册限流键影响
    expect(login.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('M5 不落库：429 场景前后 TeacherRegistry/SessionStore 差值仅含成功注册行', async () => {
    setRegisterEnv(2, 3600000);
    const app = createApp(prisma, { rateLimiter: createSlidingWindowLimiter() });
    const emails = [uniqueEmail('m5-a'), uniqueEmail('m5-b'), uniqueEmail('m5-c')];

    const first = await register(app, emails[0], 'A');
    expect(first.status).toBe(201);
    trackTeacher(first.body.data.teacher);
    const second = await register(app, emails[1], 'B');
    expect(second.status).toBe(201);
    trackTeacher(second.body.data.teacher);

    const ids = [first.body.data.teacher.id, second.body.data.teacher.id];
    const teachersBefore = await prisma.teacherRegistry.count({ where: { email: { in: emails } } });
    const sessionsBefore = await prisma.sessionStore.count({ where: { teacherId: { in: ids } } });
    expect(teachersBefore).toBe(2);
    expect(sessionsBefore).toBe(2);

    const third = await register(app, emails[2], 'C');
    expect(third.status).toBe(429);

    // 429 请求被中间件拦截：不写 TeacherRegistry/SessionStore
    const teachersAfter = await prisma.teacherRegistry.count({ where: { email: { in: emails } } });
    const sessionsAfter = await prisma.sessionStore.count({ where: { teacherId: { in: ids } } });
    expect(teachersAfter).toBe(teachersBefore);
    expect(teachersAfter).toBe(2);
    expect(sessionsAfter).toBe(sessionsBefore);
    expect(sessionsAfter).toBe(2);
  });
});
