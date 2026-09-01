import { randomBytes, scryptSync } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createAuthService } from '../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../src/shared/trusted-clock/index.js';
import { createAdminAuthService } from '../../src/features/admin/index.js';
import { createDatabaseClientPool } from '../../src/shared/database-pool/index.js';
import { createDatabaseRouter } from '../../src/app/middleware/database-router.js';
import { loadDatabaseUrl } from '../../../ops/lib/pg-utils.mjs';

/**
 * t78（A装配）：/api/v1/admin 子路由挂载 smoke 验证。
 *
 * dbRouter 形态（coreGuard requireAuth + databaseRouter）下：
 * 1. admin 登录（正确凭据）→ 200 + Set-Cookie adminToken（独立鉴权）
 * 2. admin token 访问 /admin/teachers → 200（admin 路由内部 requireAdmin 放行）
 * 3. 教师 sessionToken 访问 /admin/teachers → 401（独立鉴权互斥）
 * 4. admin token 访问教师业务 /students → 401（coreGuard requireAuth 不认 adminToken）
 * 5. admin 登录错误密码 → 401
 */

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());

const ADMIN_EMAIL = 'admin-smoke@example.com';
const ADMIN_PASSWORD = 'admin-smoke-password';
// 与 deploy/admin/gen-admin-password.mjs 同算法（scrypt$salt$derived，base64url）
const salt = randomBytes(16);
const derived = scryptSync(ADMIN_PASSWORD, salt, 64);
const ADMIN_PASSWORD_HASH = `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;

const createdTeacherIds: string[] = [];
let teacherSessionCookie: string | undefined;
let teacherPool: ReturnType<typeof createDatabaseClientPool> | undefined;

function buildApp() {
  const pool = createDatabaseClientPool({
    baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
    registerProcessHooks: false,
  });
  const router = createDatabaseRouter({
    registryPrisma: prisma,
    pool,
    registryCacheTtlMs: 60_000,
  });
  const app = createApp(prisma, {
    authService: createAuthService({
      prisma,
      clock: createDatabaseTrustedClock(prisma),
    }),
    adminAuthService: createAdminAuthService({
      email: ADMIN_EMAIL,
      passwordHash: ADMIN_PASSWORD_HASH,
    }),
    dbRouter: router,
    dbPool: pool,
    localSafeMode: false,
  });
  return { app, pool };
}

beforeAll(async () => {
  const built = buildApp();
  teacherPool = built.pool;
  const teacherAgent = request.agent(built.app);
  const register = await teacherAgent
    .post('/api/v1/auth/register')
    .send({ email: `teacher-${randomBytes(4).toString('hex')}@example.com`, password: 'password123', displayName: '教师A' });
  expect(register.status).toBe(201);
  createdTeacherIds.push(register.body.data.teacher.id);
  const login = await teacherAgent
    .post('/api/v1/auth/login')
    .send({ email: register.body.data.teacher.email, password: 'password123' });
  expect(login.status).toBe(200);
  const cookies = login.headers['set-cookie'] as unknown as string[];
  teacherSessionCookie = cookies.find((c) => c.startsWith('sessionToken='));
});

afterAll(async () => {
  // 登录产生的 SessionStore 引用教师，先删 session 再删注册表（FK 顺序）
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await teacherPool?.closeAll();
  await prisma.$disconnect();
});

describe('A装配 admin 子路由 smoke（t78）', () => {
  it('admin 登录正确凭据 → 200 + Set-Cookie adminToken', async () => {
    const { app, pool } = buildApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const cookie = res.headers['set-cookie'] as unknown as string[];
    expect(cookie.some((c) => c.startsWith('adminToken='))).toBe(true);
    await pool.closeAll();
  });

  it('admin token 访问 /admin/teachers → 200（独立鉴权放行）', async () => {
    const { app, pool } = buildApp();
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const list = await request(app)
      .get('/api/v1/admin/teachers')
      .set('Cookie', (login.headers['set-cookie'] as unknown as string[])[0]);
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(Array.isArray(list.body.data.items)).toBe(true);
    await pool.closeAll();
  });

  it('教师 sessionToken 访问 /admin/teachers → 401（独立鉴权互斥）', async () => {
    const { app, pool } = buildApp();
    const res = await request(app)
      .get('/api/v1/admin/teachers')
      .set('Cookie', teacherSessionCookie ?? '');
    expect(res.status).toBe(401);
    await pool.closeAll();
  });

  it('admin token 访问教师业务 /students → 401（教师 requireAuth 不认 adminToken）', async () => {
    const { app, pool } = buildApp();
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const students = await request(app)
      .get('/api/v1/students')
      .set('Cookie', (login.headers['set-cookie'] as unknown as string[])[0]);
    expect(students.status).toBe(401);
    await pool.closeAll();
  });

  it('admin 登录错误密码 → 401', async () => {
    const { app, pool } = buildApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-password' });
    expect(res.status).toBe(401);
    await pool.closeAll();
  });
});
