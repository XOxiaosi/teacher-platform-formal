import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAdminAuthService,
  hashAdminPassword,
  createAdminRouter,
} from '../../../src/features/admin/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createDatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  quoteIdentifier,
  runMigrateDeploy,
  withDatabase,
} from '../../../../ops/lib/pg-utils.mjs';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';

/**
 * 后台教师总览（P7 渠道线 A3）单测：
 * - 列表分页/status 过滤/不含 passwordHash；列表不触达教师库（N×M 红线断言）
 * - 详情聚合计数正确（隔离教师库真实造数验证）+ 最近 AgentExecution
 * - 超时 degraded（mock 慢查询 → 200 部分指标 + degraded）
 * - TEACHER_NOT_FOUND → 404；库未就绪/库名不安全 → 503 DATABASE_NOT_READY
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(baseUrl);
const maintenanceUrl = withDatabase(baseUrl, 'postgres');

const suffix = randomBytes(4).toString('hex');
const seedEmails: string[] = [];

async function loginAgent(app: ReturnType<typeof express>) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

function createAdminApp(overrides: {
  pool?: DatabaseClientPool;
  registryPrisma?: Pick<PrismaClient, 'teacherRegistry' | 'adminAuditLog' | 'userRequirement'>;
  aggregationTimeoutMs?: number;
} = {}) {
  const authService = createAdminAuthService({
    email: ADMIN_EMAIL,
    passwordHash: ADMIN_HASH,
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin',
    createAdminRouter({
      authService,
      loginLimiter: createSlidingWindowLimiter(),
      registryPrisma: overrides.registryPrisma ?? prisma,
      pool: overrides.pool ?? createRealPool(),
      aggregationTimeoutMs: overrides.aggregationTimeoutMs,
      // 旧教师业务库详情专项：T-014 默认封闭，这里显式只为专项测试开启。
      legacyOperationsEnabled: true,
    }),
  );
  return app;
}

function createRealPool(): DatabaseClientPool {
  return createDatabaseClientPool({
    baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
    registerProcessHooks: false,
  });
}

async function seedTeacher(email: string, databaseName = 'teacher_platform', status = 'active') {
  const teacher = await prisma.teacherRegistry.create({
    data: {
      email,
      passwordHash: 'scrypt$dummy$dummy',
      displayName: `总览测试-${email}`,
      databaseName,
      status,
    },
  });
  seedEmails.push(email);
  return teacher;
}

async function createIsolatedDb(dbName: string): Promise<void> {
  if (!/^teacher_db_[a-z0-9_]+$/.test(dbName)) throw new Error(`SAFETY_BLOCK: unsafe db name ${dbName}`);
  if (dbName === sourceDatabaseName || dbName === 'teacher_platform') {
    throw new Error('SAFETY_BLOCK: db name collides with source/shared');
  }
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(dbName)}`);
  try {
    runMigrateDeploy(withDatabase(baseUrl, dbName));
  } catch (error) {
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
    throw error;
  }
}

async function dropIsolatedDb(dbName: string): Promise<void> {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
}

afterAll(async () => {
  await prisma.teacherRegistry.deleteMany({ where: { email: { in: seedEmails } } });
  await prisma.$disconnect();
});

describe('admin teachers: 列表（共享库只读）', () => {
  let baselineTeacherCount: number;

  beforeAll(async () => {
    await seedTeacher(`list-background-${suffix}@example.com`, 'teacher_platform', 'active');
    baselineTeacherCount = await prisma.teacherRegistry.count();
    await seedTeacher(`list-a-${suffix}@example.com`, 'teacher_platform', 'active');
    await seedTeacher(`list-b-${suffix}@example.com`, 'teacher_platform', 'disabled');
    await seedTeacher(`list-c-${suffix}@example.com`, 'teacher_platform', 'active');
  });

  it('未认证访问 → 401', async () => {
    const app = createAdminApp();
    const res = await request(app).get('/api/v1/admin/teachers');
    expect(res.status).toBe(401);
  });

  it('列表返回 {items,total}，不含 passwordHash，分页生效', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const pageSize = 2;
    const res = await agent
      .get('/api/v1/admin/teachers')
      .query({ page: 1, pageSize });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const { items, total } = res.body.data;
    expect(total).toBe(baselineTeacherCount + 3);
    expect(items).toHaveLength(pageSize);
    for (const item of items) {
      expect(item).not.toHaveProperty('passwordHash');
      expect(item).toHaveProperty('email');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('databaseName');
    }

    const lastPage = Math.ceil(total / pageSize);
    const expectedLastPageSize = total - (lastPage - 1) * pageSize;
    expect(expectedLastPageSize).toBeGreaterThanOrEqual(1);
    expect(expectedLastPageSize).toBeLessThanOrEqual(pageSize);
    const lastPageRes = await agent
      .get('/api/v1/admin/teachers')
      .query({ page: lastPage, pageSize });
    expect(lastPageRes.status).toBe(200);
    expect(lastPageRes.body.data.items).toHaveLength(expectedLastPageSize);
  });

  it('status 过滤：disabled 只返回 disabled 教师', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get('/api/v1/admin/teachers').query({ status: 'disabled' });
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.items.every((item: { status: string }) => item.status === 'disabled')).toBe(true);
  });

  it('非法 status → 400', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get('/api/v1/admin/teachers').query({ status: 'banned' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('N×M 红线：列表不触达教师独立库（pool.acquire 零调用）', async () => {
    const acquire = vi.fn(async () => { throw new Error('list must not touch teacher db'); });
    const release = vi.fn();
    const app = createAdminApp({ pool: { acquire, release } as unknown as DatabaseClientPool });
    const agent = await loginAgent(app);
    const res = await agent.get('/api/v1/admin/teachers');
    expect(res.status).toBe(200);
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('admin teachers: 详情（懒加载聚合）', () => {
  const teacherDbName = `teacher_db_admin_${suffix}`;
  let teacherId: string;
  let teacherClient: PrismaClient;

  beforeAll(async () => {
    await createIsolatedDb(teacherDbName);
    // PrismaClient 构造函数不接受带 ?schema= 的 URL（CLI 可以）；剥离 query 后构造造数客户端
    const teacherDbUrl = withDatabase(baseUrl, teacherDbName).toString().split('?')[0];
    teacherClient = new PrismaClient({
      datasources: { db: { url: teacherDbUrl } },
    });
    const teacher = await seedTeacher(`detail-${suffix}@example.com`, teacherDbName, 'active');
    teacherId = teacher.id;
  });

  afterAll(async () => {
    if (teacherClient) await teacherClient.$disconnect();
    await dropIsolatedDb(teacherDbName);
  });

  it('真实隔离库造数：聚合计数正确 + 最近 AgentExecution 20 条内', async () => {
    // 造数：2 学生 / 1 缴费 / 3 次 Agent 执行
    const studentA = await teacherClient.student.create({
      data: { teacherId, name: '学生A', grade: '一年级' },
    });
    await teacherClient.student.create({
      data: { teacherId, name: '学生B', grade: '二年级' },
    });
    await teacherClient.payment.create({
      data: {
        teacherId,
        studentId: studentA.id,
        amount: 5000,
        lessonCount: 10,
        paidAtTs: new Date('2026-01-15T00:00:00.000Z'),
      },
    });
    // AgentExecution.conversationId 有 FK → 先建 Conversation 再建执行记录
    const conv = await teacherClient.conversation.create({ data: { teacherId } });
    for (let i = 0; i < 3; i += 1) {
      await teacherClient.agentExecution.create({
        data: {
          teacherId,
          conversationId: conv.id,
          clientRequestId: `client-${i}`,
          requestFingerprint: `fp-${i}`,
          status: i === 0 ? 'failed' : 'succeeded',
          stage: 'conversation',
        },
      });
    }

    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get(`/api/v1/admin/teachers/${teacherId}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.teacher.id).toBe(teacherId);
    expect(data.teacher).not.toHaveProperty('passwordHash');
    expect(data.metrics.degraded).toBe(false);
    expect(data.metrics.counts).toMatchObject({
      student: 2,
      schedule: 0,
      lesson: 0,
      payment: 1,
      feedback: 0,
      agentExecution: 3,
    });
    expect(data.metrics.recentExecutions).toHaveLength(3);
    expect(data.metrics.recentExecutions[0]).toHaveProperty('status');
  }, 30_000);

  it('TEACHER_NOT_FOUND → 404', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get('/api/v1/admin/teachers/teacher-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('库名不安全（非 teacher_db_*/非共享库）→ 503 DATABASE_NOT_READY', async () => {
    const teacher = await seedTeacher(`unsafe-${suffix}@example.com`, 'not-a-teacher-db', 'active');
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get(`/api/v1/admin/teachers/${teacher.id}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_NOT_READY');
  });

  it('教师库不存在（P1003）→ 503 DATABASE_NOT_READY', async () => {
    const missing = `teacher_db_missing_${suffix}`;
    const teacher = await seedTeacher(`missing-${suffix}@example.com`, missing, 'active');
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get(`/api/v1/admin/teachers/${teacher.id}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_NOT_READY');
  }, 30_000);

  it('聚合超时 → 200 部分指标 + degraded:true + reason:timeout（mock 慢查询）', async () => {
    // student.count 立即返回；schedule.count 永不 resolve → 超时后保留已完成部分
    const hanging = new Promise<number>(() => undefined);
    const fakeClient = {
      student: { count: vi.fn(async () => 3) },
      schedule: { count: vi.fn(() => hanging) },
      lesson: { count: vi.fn(async () => 0) },
      payment: { count: vi.fn(async () => 0) },
      feedback: { count: vi.fn(async () => 0) },
      agentExecution: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    };
    const acquire = vi.fn(async () => fakeClient);
    const release = vi.fn();
    const app = createAdminApp({
      pool: { acquire, release } as unknown as DatabaseClientPool,
      aggregationTimeoutMs: 60,
    });
    const teacher = await seedTeacher(`timeout-${suffix}@example.com`, 'teacher_platform', 'active');
    const agent = await loginAgent(app);
    const res = await agent.get(`/api/v1/admin/teachers/${teacher.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.metrics.degraded).toBe(true);
    expect(res.body.data.metrics.reason).toBe('timeout');
    // 部分指标：student 已完成，schedule 之后未执行
    expect(res.body.data.metrics.counts.student).toBe(3);
    expect(res.body.data.metrics.counts.schedule).toBeUndefined();
    expect(release).toHaveBeenCalledWith('teacher_platform'); // 池连接已释放（不做死连接）
  }, 10_000);
});
