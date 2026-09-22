import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAdminAuthService,
  createAdminRouter,
  getAdminUsageSummary,
  hashAdminPassword,
} from '../../../src/features/admin/index.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import { loadDatabaseUrl } from '../../../../ops/lib/pg-utils.mjs';
import { createDatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import { seedInvitation } from '../../helpers/invitations.js';

/**
 * 平台级用量总览（P8 第六批 t28，设计 p7-admin-panel-design.md §6）单测：
 * - getAdminUsageSummary：跨教师/provider/model 聚合正确性（totals + byProvider 降序）+ 时段过滤
 *   + teacherId 单教师钻取；from/to 校验（缺失/非法/from>=to → VALIDATION_ERROR）
 * - 库未就绪 → DATABASE_NOT_READY（stub 抛 DB 类错误）
 * - 路由：未登录 401；教师 token 访问 → 401（独立鉴权互斥）；admin 登录后 200 + 聚合正确
 * 隔离库由 run-tests-isolated.mjs 创建并 drop；本文件只写共享表（不建 teacher_db_*）。
 * 测试隔离（R4 残留清理同源）：全量跑时同一隔离库可能残留其它测试（provider-usage 域等）的
 * ProviderUsage 行，绝对计数断言会被污染——beforeAll 全清表，保证断言基线从 0 起算。
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());

const createdTeacherIds: string[] = [];

function createAdminApp(overrides: { pool?: DatabaseClientPool } = {}) {
  const authService = createAdminAuthService({ email: ADMIN_EMAIL, passwordHash: ADMIN_HASH });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin',
    createAdminRouter({
      authService,
      loginLimiter: createSlidingWindowLimiter(),
      registryPrisma: prisma,
      pool: overrides.pool ?? createDatabaseClientPool({
        baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
        registerProcessHooks: false,
      }),
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

function uniqueId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

async function createTeacher(displayName: string): Promise<string> {
  const id = uniqueId('teacher');
  await prisma.teacherRegistry.create({
    data: {
      id,
      email: `${id}@example.com`,
      passwordHash: 'scrypt:test',
      displayName,
      status: 'active',
    },
  });
  createdTeacherIds.push(id);
  return id;
}

// 受控种子：3 教师 × 多 provider/model，requestAt 分布在固定窗口内（另留窗口外数据验证时段过滤）
const WINDOW_FROM_ISO = '2026-09-01T00:00:00.000Z';
const WINDOW_TO_ISO = '2026-09-02T00:00:00.000Z';

let teacherA: string;
let teacherB: string;
let teacherC: string;

beforeAll(async () => {
  // 测试隔离：全清 ProviderUsage（无 FK 依赖，直接清），保证绝对计数从 0 起算
  await prisma.providerUsage.deleteMany({});
  teacherA = await createTeacher('usage-admin-a');
  teacherB = await createTeacher('usage-admin-b');
  teacherC = await createTeacher('usage-admin-c');

  const rows = [
    // teacherA：deepseek-chat ×2 + qwen-plus ×1（窗口内）
    { teacherId: teacherA, providerName: 'deepseek', model: 'deepseek-chat', promptTokens: 100, completionTokens: 50, requestAt: new Date('2026-09-01T01:00:00.000Z') },
    { teacherId: teacherA, providerName: 'deepseek', model: 'deepseek-chat', promptTokens: 40, completionTokens: 20, requestAt: new Date('2026-09-01T02:00:00.000Z') },
    { teacherId: teacherA, providerName: 'qwen', model: 'qwen-plus', promptTokens: 10, completionTokens: 5, requestAt: new Date('2026-09-01T03:00:00.000Z') },
    // teacherB：deepseek-chat ×1 + 窗口外 1 条（验证时段过滤）
    { teacherId: teacherB, providerName: 'deepseek', model: 'deepseek-chat', promptTokens: 200, completionTokens: 100, requestAt: new Date('2026-09-01T04:00:00.000Z') },
    { teacherId: teacherB, providerName: 'deepseek', model: 'deepseek-chat', promptTokens: 999, completionTokens: 999, requestAt: new Date('2026-09-03T00:00:00.000Z') },
    // teacherC：ark/doubao ×1（窗口内）
    { teacherId: teacherC, providerName: 'ark', model: 'doubao', promptTokens: 30, completionTokens: 15, requestAt: new Date('2026-09-01T05:00:00.000Z') },
  ];
  for (const row of rows) {
    await prisma.providerUsage.create({ data: row });
  }
});

afterAll(async () => {
  await prisma.providerUsage.deleteMany({});
  // 登录产生的 SessionStore 引用教师，先删 session 再删注册表（FK 顺序，与 admin-mount-smoke 同款）
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

describe('getAdminUsageSummary 平台聚合', () => {
  it('跨教师聚合：totals + byProvider（providerName/model 分组，totalTokens 降序）', async () => {
    const result = await getAdminUsageSummary(prisma, { from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value;

    // 窗口内 5 条（teacherA 3 + teacherB 1 + teacherC 1；teacherB 窗口外 1 条不计）
    expect(summary.totals.requests).toBe(5);
    expect(summary.totals.promptTokens).toBe(100 + 40 + 10 + 200 + 30); // 380
    expect(summary.totals.completionTokens).toBe(50 + 20 + 5 + 100 + 15); // 190
    expect(summary.totals.totalTokens).toBe(570);

    // deepseek-chat: 3 条（A×2+B×1）→ prompt 340 / completion 170 / total 510
    // qwen-plus: 1 条 → 15；doubao: 1 条 → 45
    expect(summary.byProvider).toHaveLength(3);
    expect(summary.byProvider[0]).toEqual({
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 340,
      completionTokens: 170,
      totalTokens: 510,
      requests: 3,
    });
    expect(summary.byProvider[1]).toEqual({
      providerName: 'ark',
      model: 'doubao',
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
      requests: 1,
    });
    expect(summary.byProvider[2]).toEqual({
      providerName: 'qwen',
      model: 'qwen-plus',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      requests: 1,
    });
    // byProvider 按 totalTokens 降序：510 > 45 > 15
    expect(summary.byProvider.map((r) => r.totalTokens)).toEqual([510, 45, 15]);
  });

  it('teacherId 单教师钻取：只聚合该教师窗口内行', async () => {
    const result = await getAdminUsageSummary(prisma, { from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO, teacherId: teacherA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value;
    expect(summary.teacherId).toBe(teacherA);
    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.totalTokens).toBe(150 + 60 + 15); // deepseek 150+60 + qwen 15
    expect(summary.byProvider).toHaveLength(2);
  });

  it('时段过滤：窗口外行不计（teacherB 的 09-03 行被排除）', async () => {
    const result = await getAdminUsageSummary(prisma, { from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO, teacherId: teacherB });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value;
    expect(summary.totals.requests).toBe(1);
    expect(summary.totals.totalTokens).toBe(300); // 200+100，不含 999+999
  });

  it('校验：from/to 缺失或非法 / from>=to → VALIDATION_ERROR', async () => {
    for (const input of [
      { from: undefined, to: WINDOW_TO_ISO },
      { from: WINDOW_FROM_ISO, to: undefined },
      { from: 'not-a-date', to: WINDOW_TO_ISO },
      { from: WINDOW_TO_ISO, to: WINDOW_FROM_ISO }, // from >= to
      { from: WINDOW_FROM_ISO, to: WINDOW_FROM_ISO },
    ]) {
      const result = await getAdminUsageSummary(prisma, input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.field).toBe('query');
    }
  });

  it('库未就绪（findMany 抛 DB 类错误）→ DATABASE_NOT_READY', async () => {
    const stub = {
      providerUsage: {
        findMany: async () => { throw new Error('connection refused: postgres'); },
      },
    };
    const result = await getAdminUsageSummary(stub as never, { from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DATABASE_NOT_READY');
  });
});

describe('GET /api/v1/admin/usage/summary 路由', () => {
  it('未登录 → 401', async () => {
    const app = createAdminApp();
    const res = await request(app).get('/api/v1/admin/usage/summary').query({ from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO });
    expect(res.status).toBe(401);
  });

  it('教师 sessionToken 访问 → 401（独立鉴权互斥）', async () => {
    // 装配教师认证路由（与 admin-mount-smoke 同款互斥验证）：教师登录后拿 sessionToken，
    // 访问 /api/v1/admin/usage/summary → 401（createRequireAdmin 不认教师 token）
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createAuthRouter(
      createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) }),
    ));
    app.use(
      '/api/v1/admin',
      createAdminRouter({
        authService: createAdminAuthService({ email: ADMIN_EMAIL, passwordHash: ADMIN_HASH }),
        loginLimiter: createSlidingWindowLimiter(),
        registryPrisma: prisma,
        pool: createDatabaseClientPool({
          baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
          registerProcessHooks: false,
        }),
      }),
    );

    const email = `teacher-usage-${randomBytes(4).toString('hex')}@example.com`;
    const teacherAgent = request.agent(app);
    const invitation = await seedInvitation(prisma, { email });
    const accepted = await teacherAgent
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: '用量鉴权教师' });
    expect(accepted.status).toBe(201);
    const teacherId = accepted.body.data.teacher.id;
    createdTeacherIds.push(teacherId);

    const res = await teacherAgent
      .get('/api/v1/admin/usage/summary')
      .query({ from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO });
    expect(res.status).toBe(401);
  });

  it('登录后 → 200 聚合正确；缺 from/to → 400', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);

    const res = await agent
      .get('/api/v1/admin/usage/summary')
      .query({ from: WINDOW_FROM_ISO, to: WINDOW_TO_ISO });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totals.requests).toBe(5);
    expect(res.body.data.totals.totalTokens).toBe(570);
    expect(res.body.data.byProvider[0].providerName).toBe('deepseek');

    const bad = await agent.get('/api/v1/admin/usage/summary').query({ from: 'x', to: 'y' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});
