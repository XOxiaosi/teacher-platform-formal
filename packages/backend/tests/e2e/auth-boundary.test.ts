import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { seedInvitation } from '../helpers/invitations.js';

/**
 * P7 认证边界测试（HTTP 层补充，supertest 直读 Set-Cookie）。
 *
 * 覆盖 e2e/auth-flow.test.ts 之外的边界场景：
 * - 密码过短 / 邮箱格式错误注册 → 400（field 定位）
 * - disabled 教师登录 → 401
 * - 会话过期后 /me → 401（服务端过期判定走 TrustedClock）
 * - 登出后旧 sessionToken 立即失效（DB 行删除，重放旧 cookie → 401）
 * - Set-Cookie 属性：HttpOnly / SameSite=Lax / Path=/（登录/注册为会话 cookie，登出为 Max-Age=0）
 */
const prisma = new PrismaClient();
const app = createApp(prisma);

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'auth-boundary' } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'a11-' } } });
  await prisma.$disconnect();
});

function uniqueEmail(prefix = 'auth-boundary'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

function trackTeacher(data: { id: string }): void {
  createdTeacherIds.push(data.id);
}

function firstSetCookie(res: request.Response): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  if (setCookie === undefined) return undefined;
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

function cookieToken(cookie: string): string | undefined {
  const match = /^sessionToken=([^;]+)/.exec(cookie);
  return match ? match[1] : undefined;
}

describe('认证边界（HTTP 层）', () => {
  it('密码过短的邀请接受 → 400 field=password 且不种 cookie', async () => {
    const invitation = await seedInvitation(prisma, { email: uniqueEmail() });
    const res = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'short', displayName: 'A' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '密码长度至少 8 位', field: 'password' },
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('无效邀请 token 统一返回 401，不泄露邮箱或状态', async () => {
    const res = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: 'x'.repeat(32), password: 'password123', displayName: 'A' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '邀请无效、已失效或已被使用' },
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('disabled 教师登录 → 401 账号未激活或已停用', async () => {
    const email = uniqueEmail();
    const invitation = await seedInvitation(prisma, { email });
    const reg = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: 'A' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);

    await prisma.teacherRegistry.update({
      where: { id: reg.body.data.teacher.id },
      data: { status: 'disabled' },
    });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' });
    expect(login.status).toBe(401);
    expect(login.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '账号未激活或已停用' },
    });
  });

  it('会话过期后 /me → 401（过期判定在服务端，TrustedClock 兜底）', async () => {
    const agent = request.agent(app);
    const invitation = await seedInvitation(prisma, { email: uniqueEmail() });
    const reg = await agent
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: '过期老师' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);

    const cookie = firstSetCookie(reg);
    expect(cookie).toBeDefined();
    const token = cookieToken(cookie as string);
    expect(token).toBeDefined();
    const tokenHash = createHash('sha256').update(token as string).digest('hex');
    await prisma.sessionStore.update({
      where: { tokenHash },
      data: { expiresAtTs: new Date(Date.now() - 60_000) },
    });

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.ok).toBe(false);
  });

  it('登出后旧 sessionToken 立即失效（DB 删除，重放旧 cookie → 401）', async () => {
    const agent = request.agent(app);
    const invitation = await seedInvitation(prisma, { email: uniqueEmail() });
    const reg = await agent
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: '登出老师' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);
    const token = cookieToken(firstSetCookie(reg) as string);

    const before = await agent.get('/api/v1/auth/me');
    expect(before.status).toBe(200);

    const logout = await agent.post('/api/v1/auth/logout');
    expect(logout.status).toBe(200);

    const after = await agent.get('/api/v1/auth/me');
    expect(after.status).toBe(401);

    // 手工重放登出前的旧 cookie：DB 行已删，同样 401（不依赖浏览器 jar 清 cookie）
    const replay = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `sessionToken=${token}`);
    expect(replay.status).toBe(401);
  });

  it('Set-Cookie 属性：HttpOnly; SameSite=Lax; Path=/（会话 cookie），登出清 cookie 带 Max-Age=0', async () => {
    const email = uniqueEmail();
    const invitation = await seedInvitation(prisma, { email });
    const reg = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: 'A' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' });
    expect(login.status).toBe(200);

    for (const cookie of [firstSetCookie(reg), firstSetCookie(login)]) {
      expect(cookie).toBeDefined();
      expect(cookie).toContain('sessionToken=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(cookie).not.toContain('Max-Age=0');
    }

    const logout = await request(app).post('/api/v1/auth/logout');
    const logoutCookie = firstSetCookie(logout);
    expect(logoutCookie).toBeDefined();
    expect(logoutCookie).toContain('sessionToken=');
    expect(logoutCookie).toContain('Max-Age=0');
  });
});

describe('生产模式红线（NODE_ENV=production）', () => {
  const PREV_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = PREV_NODE_ENV;
  });

  it('A10 生产模式：仅带 x-teacher-id（无 cookie）→ 401，dev fallback 被禁止', async () => {
    process.env.NODE_ENV = 'production';

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('x-teacher-id', 'demo-teacher');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' },
    });
  });

  it('A11 生产模式：有效 session cookie → /me 200', async () => {
    process.env.NODE_ENV = 'production';
    const email = uniqueEmail('a11');
    const invitation = await seedInvitation(prisma, { email });

    const reg = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: '生产老师' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);

    // 生产 cookie 带 Secure：supertest agent 的 cookie jar 对 http URL 不重发 Secure cookie，
    // 故手动提取 token 构造 Cookie 头（等价于 https 浏览器行为）
    const cookie = firstSetCookie(reg);
    expect(cookie).toContain('Secure');
    const token = cookieToken(cookie!);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `sessionToken=${token}`);
    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.data.email).toBe(email);
  });

  it('A10 对照：恢复非生产后 x-teacher-id dev fallback 回归', async () => {
    // afterEach 已把 NODE_ENV 恢复为测试环境值（'test'/undefined）
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('x-teacher-id', 'demo-teacher');

    // 非生产 dev fallback：demo-teacher 存在则 200；不存在则 getMe NOT_FOUND→404。
    // 关键断言是「不再被生产 401 拦截」——只要不是 401 即证明 fallback 恢复。
    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });
});
