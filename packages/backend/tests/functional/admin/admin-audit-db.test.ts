import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAdminAuthService,
  createAdminRouter,
  hashAdminPassword,
  recordAdminActionDb,
} from '../../../src/features/admin/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import type { Logger } from '../../../src/shared/logger/index.js';
import { loadDatabaseUrl } from '../../../../ops/lib/pg-utils.mjs';
import { createDatabaseClientPool } from '../../../src/shared/database-pool/index.js';

/**
 * A6 AdminAuditLog 表化审计单测：
 * - recordAdminActionDb：真实库落库（actor/action/objectType/objectId/ip/detail；失败 action=.failed）
 * - 无 prisma → 纯日志退化，不抛错；写库失败 → 吞掉 + warn（审计旁路不阻断主动作）
 * - 路由级：POST /teachers 成功 → teacher.create 行；缺 confirm → backup.run.failed 行 + 400
 * 隔离库由 run-tests-isolated.mjs 创建并 drop；本文件只写共享表（不建 teacher_db_*）。
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());

const suffix = Date.now().toString(36);
const seedEmails: string[] = [];

function mockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createAdminApp(overrides: { logger?: Logger } = {}) {
  const authService = createAdminAuthService({ email: ADMIN_EMAIL, passwordHash: ADMIN_HASH });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin',
    createAdminRouter({
      authService,
      loginLimiter: createSlidingWindowLimiter(),
      registryPrisma: prisma,
      pool: createDatabaseClientPool({
        baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
        registerProcessHooks: false,
      }),
      logger: overrides.logger,
    }),
  );
  return app;
}

async function loginAgent(app: ReturnType<typeof express>) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  // 清理本文件历史残留（同前缀），保证断言精确
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: ADMIN_EMAIL } });
});

afterAll(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: ADMIN_EMAIL } });
  await prisma.teacherRegistry.deleteMany({ where: { email: { in: seedEmails } } });
  await prisma.$disconnect();
});

describe('recordAdminActionDb 表落库', () => {
  it('真实库写入：actor/action/objectType/objectId/ip/detail', async () => {
    await recordAdminActionDb(prisma, undefined, {
      actor: ADMIN_EMAIL,
      action: 'teacher.create',
      objectType: 'teacher',
      objectId: 'clx_audit_unit',
      detail: { note: 'unit-test' },
      ip: '127.0.0.1',
    });

    const row = await prisma.adminAuditLog.findFirst({
      where: { actorEmail: ADMIN_EMAIL, objectId: 'clx_audit_unit' },
      orderBy: { createdAtTs: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row?.action).toBe('teacher.create');
    expect(row?.objectType).toBe('teacher');
    expect(row?.ip).toBe('127.0.0.1');
    expect(row?.detail).toMatchObject({ note: 'unit-test' });
    expect(row?.createdAtTs).toBeInstanceOf(Date);
  });

  it('失败动作：action 追加 .failed 且 detail.error 内联', async () => {
    await recordAdminActionDb(prisma, undefined, {
      actor: ADMIN_EMAIL,
      action: 'teacher.create',
      objectType: 'teacher',
      error: { code: 'ALREADY_CONSUMED', message: '重复', field: 'email' },
      ip: '10.0.0.1',
    });

    const rows = await prisma.adminAuditLog.findMany({
      where: { actorEmail: ADMIN_EMAIL, action: 'teacher.create.failed' },
      orderBy: { createdAtTs: 'desc' },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ error: { code: 'ALREADY_CONSUMED' } });
    expect(rows[0].ip).toBe('10.0.0.1');
  });

  it('无 prisma → 纯日志退化，resolve 不抛错', async () => {
    const logger = mockLogger();
    await expect(
      recordAdminActionDb(undefined, logger, {
        actor: ADMIN_EMAIL,
        action: 'backup.run',
        objectType: 'backup',
      }),
    ).resolves.toBeUndefined();
    const info = logger.info as ReturnType<typeof vi.fn>;
    expect(info).toHaveBeenCalledWith('admin action', expect.objectContaining({ action: 'backup.run' }));
  });

  it('写库失败 → 吞掉 + warn（审计旁路不阻断主动作）', async () => {
    const logger = mockLogger();
    const brokenPrisma = {
      adminAuditLog: {
        create: async () => { throw new Error('db exploded'); },
      },
    };
    await expect(
      recordAdminActionDb(brokenPrisma as never, logger, {
        actor: ADMIN_EMAIL,
        action: 'restore.run',
        objectType: 'backup',
        objectId: 'clx_x',
      }),
    ).resolves.toBeUndefined();
    const warn = logger.warn as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledWith('admin audit db write failed', expect.objectContaining({ error: 'db exploded' }));
  });
});

describe('路由动作 → AdminAuditLog 行', () => {
  it('POST /teachers 成功 → teacher.create 行（actorEmail=admin）', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const email = `audit-create-${suffix}@example.com`;
    const res = await agent.post('/api/v1/admin/teachers').send({
      email,
      password: 'teacher-pass-123',
      displayName: '审计测试',
    });
    expect(res.status).toBe(201);
    seedEmails.push(email);
    const teacherId = res.body.data.teacher.id;

    const row = await prisma.adminAuditLog.findFirst({
      where: { actorEmail: ADMIN_EMAIL, action: 'teacher.create', objectId: teacherId },
      orderBy: { createdAtTs: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row?.objectType).toBe('teacher');
  });

  it('POST /backup 缺 confirm → backup.run.failed 行 + 400', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.post('/api/v1/admin/backup').send({});
    expect(res.status).toBe(400);

    const row = await prisma.adminAuditLog.findFirst({
      where: { actorEmail: ADMIN_EMAIL, action: 'backup.run.failed' },
      orderBy: { createdAtTs: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row?.detail).toMatchObject({ error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) });
  });

  it('登录审计不进 AdminAuditLog（auth 属认证域，非管理动作）', async () => {
    const app = createAdminApp();
    await loginAgent(app);
    const row = await prisma.adminAuditLog.findFirst({
      where: { actorEmail: ADMIN_EMAIL, action: 'auth.login' },
    });
    expect(row).toBeNull();
  });
});
