import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';

const prisma = new PrismaClient();
const app = createApp(prisma);

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function uniqueEmail(prefix = 'auth-flow'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

function trackTeacher(data: { id: string }): void {
  createdTeacherIds.push(data.id);
}

describe('POST /api/v1/auth/register', () => {
  it('注册成功：201 + Set-Cookie sessionToken（HttpOnly; SameSite=Lax; Path=/）+ 公开信息', async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: '测试老师' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.teacher.email).toBe(email);
    expect(res.body.data.teacher.displayName).toBe('测试老师');
    expect(res.body.data.teacher).not.toHaveProperty('passwordHash');
    expect(typeof res.body.data.expiresAtTs).toBe('number');

    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie).toBeDefined();
    const cookie = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    expect(cookie).toContain('sessionToken=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    trackTeacher(res.body.data.teacher);
  });

  it('重复邮箱注册 → 400（validationError）', async () => {
    const email = uniqueEmail();
    const first = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: 'A' });
    expect(first.status).toBe(201);
    trackTeacher(first.body.data.teacher);

    const second = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: 'B' });
    expect(second.status).toBe(400);
    expect(second.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '该邮箱已注册', field: 'email' },
    });
  });

  it('body 缺字段 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('登录成功：200 + Set-Cookie；错误密码 401', async () => {
    const email = uniqueEmail();
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: 'A' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    const setCookie = login.headers['set-cookie'] as unknown as string[] | undefined;
    expect(Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).toContain('sessionToken=');

    const bad = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '邮箱或密码错误' },
    });
  });

  it('不存在邮箱与密码错误返回同一 401（防枚举）', async () => {
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'whatever123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '邮箱或密码错误' },
    });
  });
});

describe('GET /api/v1/auth/me + 登出链路', () => {
  it('注册→me→登出→me 401 完整链路（agent 自动携带 cookie）', async () => {
    const agent = request.agent(app);
    const email = uniqueEmail();

    const reg = await agent
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: '链路老师' });
    expect(reg.status).toBe(201);
    trackTeacher(reg.body.data.teacher);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.data.email).toBe(email);
    expect(me.body.data.displayName).toBe('链路老师');
    expect(me.body.data).not.toHaveProperty('passwordHash');

    const logout = await agent.post('/api/v1/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true, data: { ok: true } });
    const setCookie = logout.headers['set-cookie'] as unknown as string[] | undefined;
    expect(Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).toContain('Max-Age=0');

    const meAfterLogout = await agent.get('/api/v1/auth/me');
    expect(meAfterLogout.status).toBe(401);
  });

  it('未带 cookie 且无 x-teacher-id 访问 /me → 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('无效 sessionToken cookie → 401（非生产无 x-teacher-id fallback）', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'sessionToken=definitely-invalid-token');
    expect(res.status).toBe(401);
  });

  it('登出幂等：无 cookie 时 POST /logout 仍 200', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { ok: true } });
  });
});

describe('cookie Secure 属性（P1，t38 §1.5）', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('非生产（默认/开发）：Set-Cookie 不含 Secure（本机 http 登录可用）', async () => {
    process.env.NODE_ENV = 'development';
    const email = uniqueEmail('auth-secure-dev');
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: '开发' });
    expect(res.status).toBe(201);
    trackTeacher(res.body.data.teacher);
    const cookie = Array.isArray(res.headers['set-cookie'])
      ? (res.headers['set-cookie'] as unknown as string[])[0]
      : String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('生产（NODE_ENV=production）：Set-Cookie 含 Secure（HTTPS 下会话不被明文传输）', async () => {
    process.env.NODE_ENV = 'production';
    const email = uniqueEmail('auth-secure-prod');
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: '生产' });
    expect(res.status).toBe(201);
    trackTeacher(res.body.data.teacher);
    const cookie = Array.isArray(res.headers['set-cookie'])
      ? (res.headers['set-cookie'] as unknown as string[])[0]
      : String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });
});
