import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * 后台交互/健康看板（P7 渠道线 A4）单测：
 * - interactions：status 分布/耗时/错误率/最近交互时间（真实隔离库造数）+ from/to 窗口 + 404/503 + 超时 degraded
 * - health：ready/teacherDbs 分类/备份 MANIFEST（存在与缺失降级）/迁移版本/metrics 标注
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
  registryPrisma?: Pick<PrismaClient, 'teacherRegistry' | '$queryRaw' | 'adminAuditLog' | 'userRequirement'>;
  aggregationTimeoutMs?: number;
} = {}) {
  const authService = createAdminAuthService({ email: ADMIN_EMAIL, passwordHash: ADMIN_HASH });
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

async function seedTeacher(email: string, databaseName: string) {
  const teacher = await prisma.teacherRegistry.create({
    data: {
      email,
      passwordHash: 'scrypt$dummy$dummy',
      displayName: `看板测试-${email}`,
      databaseName,
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

describe('admin interactions: AgentExecution 统计', () => {
  const teacherDbName = `teacher_db_int_${suffix}`;
  let teacherId: string;
  let teacherClient: PrismaClient;
  let convId: string;

  beforeAll(async () => {
    await createIsolatedDb(teacherDbName);
    const teacherDbUrl = withDatabase(baseUrl, teacherDbName).toString().split('?')[0];
    teacherClient = new PrismaClient({ datasources: { db: { url: teacherDbUrl } } });
    const teacher = await seedTeacher(`int-${suffix}@example.com`, teacherDbName);
    teacherId = teacher.id;
    const conv = await teacherClient.conversation.create({ data: { teacherId } });
    convId = conv.id;
  });

  afterAll(async () => {
    if (teacherClient) await teacherClient.$disconnect();
    await dropIsolatedDb(teacherDbName);
  });

  async function seedExecutions(): Promise<void> {
    await teacherClient.agentExecution.createMany({
      data: [
        { teacherId, conversationId: convId, clientRequestId: 'c0', requestFingerprint: 'f0', status: 'succeeded', stage: 'model', startedAtTs: new Date('2026-01-01T01:00:00.000Z'), finishedAtTs: new Date('2026-01-01T01:00:01.000Z') },   // 1000ms
        { teacherId, conversationId: convId, clientRequestId: 'c1', requestFingerprint: 'f1', status: 'succeeded', stage: 'model', startedAtTs: new Date('2026-01-01T02:00:00.000Z'), finishedAtTs: new Date('2026-01-01T02:00:03.000Z') },   // 3000ms
        { teacherId, conversationId: convId, clientRequestId: 'c2', requestFingerprint: 'f2', status: 'failed', stage: 'model', startedAtTs: new Date('2026-01-01T03:00:00.000Z'), finishedAtTs: new Date('2026-01-01T03:00:00.500Z') },     // 500ms
        { teacherId, conversationId: convId, clientRequestId: 'c3', requestFingerprint: 'f3', status: 'running', stage: 'conversation', startedAtTs: new Date('2026-01-02T00:00:00.000Z') },
      ],
    });
  }

  it('统计正确：status 分布/耗时/错误率/最近交互/usage 不可用（真实隔离库造数）', async () => {
    await seedExecutions();
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.get('/api/v1/admin/interactions').query({ teacherId });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.counts).toEqual({
      succeeded: 2,
      failed: 1,
      partial: 0,
      waiting_confirmation: 0,
      running: 1,
      totalTerminal: 3,
    });
    expect(data.errorRate).toBeCloseTo(1 / 3, 5);
    expect(data.durationMs.avg).toBe(1500); // (1000+3000+500)/3
    expect(data.durationMs.max).toBe(3000);
    expect(data.lastInteractionAt).toContain('2026-01-02');
    expect(data.usage).toEqual({
      available: false,
      reason: expect.stringContaining('token'),
    });
    expect(data.degraded).toBe(false);
  }, 30_000);

  it('from/to 窗口过滤（按 startedAtTs）', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent
      .get('/api/v1/admin/interactions')
      .query({ teacherId, from: '2026-01-01T00:00:00Z', to: '2026-01-01T23:59:59Z' });
    expect(res.status).toBe(200);
    expect(res.body.data.counts.succeeded).toBe(2);
    expect(res.body.data.counts.failed).toBe(1);
    expect(res.body.data.counts.running).toBe(0);
    expect(res.body.data.window).toEqual({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T23:59:59Z' });
  });

  it('from 晚于 to → 400 VALIDATION_ERROR', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent
      .get('/api/v1/admin/interactions')
      .query({ teacherId, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('缺 teacherId → 400；未知教师 → 404；库缺失 → 503', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const noId = await agent.get('/api/v1/admin/interactions');
    expect(noId.status).toBe(400);

    const notFound = await agent.get('/api/v1/admin/interactions').query({ teacherId: 'unknown-teacher' });
    expect(notFound.status).toBe(404);

    const missing = await seedTeacher(`int-missing-${suffix}@example.com`, `teacher_db_int_missing_${suffix}`);
    const dbMissing = await agent.get('/api/v1/admin/interactions').query({ teacherId: missing.id });
    expect(dbMissing.status).toBe(503);
    expect(dbMissing.body.error.code).toBe('DATABASE_NOT_READY');
  }, 30_000);

  it('查询超时 → degraded:true + reason:timeout + 空统计 + release（mock 慢查询）', async () => {
    const hanging = new Promise<never>(() => undefined);
    const fakeClient = {
      agentExecution: { findMany: vi.fn(() => hanging) },
    };
    const acquire = vi.fn(async () => fakeClient);
    const release = vi.fn();
    const app = createAdminApp({
      pool: { acquire, release } as unknown as DatabaseClientPool,
      aggregationTimeoutMs: 60,
    });
    const teacher = await seedTeacher(`int-timeout-${suffix}@example.com`, 'teacher_platform');
    const agent = await loginAgent(app);
    const res = await agent.get('/api/v1/admin/interactions').query({ teacherId: teacher.id });
    expect(res.status).toBe(200);
    expect(res.body.data.degraded).toBe(true);
    expect(res.body.data.reason).toBe('timeout');
    expect(res.body.data.counts.totalTerminal).toBe(0);
    expect(release).toHaveBeenCalledWith('teacher_platform');
  }, 10_000);
});

describe('admin health: 系统健康聚合', () => {
  const createdHealthDbs: string[] = [];

  afterAll(async () => {
    // R4 纪律：health 测试建库在 afterAll 无条件清理（断言失败路径也不残留）
    for (const dbName of createdHealthDbs) {
      await dropIsolatedDb(dbName);
    }
  });

  it('health 聚合：ready/teacherDbs 分类/迁移版本/metrics 标注（真实库）', async () => {
    const dbName = `teacher_db_hl_${suffix}`;
    await createIsolatedDb(dbName);
    createdHealthDbs.push(dbName);
    await seedTeacher(`hl-${suffix}@example.com`, dbName);
    await seedTeacher(`hl-missing-${suffix}@example.com`, `teacher_db_hl_missing_${suffix}`);

    // 强制空 BACKUP_ROOT：备份缺失降级断言（避免命中宿主默认备份目录）
    const emptyRoot = await mkdtemp(join(tmpdir(), 'tp-admin-health-'));
    const previous = process.env.BACKUP_ROOT;
    process.env.BACKUP_ROOT = emptyRoot;

    const app = createAdminApp();
    const agent = await loginAgent(app);
    try {
      const res = await agent.get('/api/v1/admin/health');
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.ready.ok).toBe(true);
      expect(data.ready.sharedDb).toBe('ok');
      expect(data.migrations.shared.migrations).toBeGreaterThanOrEqual(13);
      expect(data.migrations.shared.tables).toBeGreaterThanOrEqual(24);
      expect(data.teacherDbs.total).toBeGreaterThanOrEqual(2);
      const okEntry = data.teacherDbs.checked.find((item: { databaseName: string }) => item.databaseName === dbName);
      expect(okEntry.status).toBe('ok');
      const missingEntry = data.teacherDbs.checked.find(
        (item: { databaseName: string }) => item.databaseName === `teacher_db_hl_missing_${suffix}`,
      );
      expect(missingEntry.status).toBe('missing');
      expect(data.metrics.available).toBe(false);
      expect(data.backup.exists).toBe(false); // 空 BACKUP_ROOT → 降级非 500
    } finally {
      if (previous === undefined) delete process.env.BACKUP_ROOT;
      else process.env.BACKUP_ROOT = previous;
      await rm(emptyRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('备份 MANIFEST 存在时解析最新（okCount/failedCount/runId）', async () => {
    const backupRoot = await mkdtemp(join(tmpdir(), 'tp-admin-health-'));
    await mkdir(join(backupRoot, 'daily'), { recursive: true });
    await writeFile(
      join(backupRoot, 'daily', 'MANIFEST-20260821T010000.json'),
      JSON.stringify({ runId: '20260821T010000', total: 5, ok: 5, failed: 0 }),
    );
    await writeFile(
      join(backupRoot, 'daily', 'MANIFEST-20260821T020000.json'),
      JSON.stringify({ runId: '20260821T020000', total: 5, ok: 4, failed: 1 }),
    );

    const app = createAdminApp();
    const cookie = await adminCookie(app);
    const previous = process.env.BACKUP_ROOT;
    process.env.BACKUP_ROOT = backupRoot;
    try {
      const withRoot = await request(app).get('/api/v1/admin/health').set('Cookie', cookie);
      expect(withRoot.status).toBe(200);
      expect(withRoot.body.data.backup.exists).toBe(true);
      expect(withRoot.body.data.backup.latestRunId).toBe('20260821T020000');
      expect(withRoot.body.data.backup.okCount).toBe(4);
      expect(withRoot.body.data.backup.failedCount).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.BACKUP_ROOT;
      else process.env.BACKUP_ROOT = previous;
      await rm(backupRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('未认证访问 /admin/health → 401', async () => {
    const app = createAdminApp();
    const res = await request(app).get('/api/v1/admin/health');
    expect(res.status).toBe(401);
  });
});

/** 登录并返回 adminToken cookie 值（供 request().set('Cookie') 使用）。 */
async function adminCookie(app: ReturnType<typeof express>): Promise<string> {
  const res = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return cookie.split(';')[0];
}
