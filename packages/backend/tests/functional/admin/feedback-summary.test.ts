import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAdminAuthService,
  createAdminRouter,
  getFeedbackSummary,
  hashAdminPassword,
} from '../../../src/features/admin/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import { loadDatabaseUrl } from '../../../../ops/lib/pg-utils.mjs';
import { createDatabaseClientPool } from '../../../src/shared/database-pool/index.js';

/**
 * 反馈看板数据源（P7 渠道线 A6）单测：
 * - getFeedbackSummary 聚合正确性（total / byStatus / byPriority / byCategory 排序 / recent 降序）
 * - limit 校验（0/101/小数 → VALIDATION_ERROR；默认 20）
 * - 库未就绪 → DATABASE_NOT_READY（stub 抛 DB 类错误）
 * - 路由：未登录 401；登录后 200 + limit 生效
 * 隔离库由 run-tests-isolated.mjs 创建并 drop，本文件只写共享表（不建 teacher_db_*）。
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());

const seedQuotePrefix = `fb-summary-${Date.now()}-`;
const seededIds: string[] = [];

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

beforeAll(async () => {
  // 测试隔离（R4 残留清理同源）：全量跑（--no-file-parallelism）时本隔离库可能残留
  // 其它测试（requirements 域、feedback 工具等）的 UserRequirement 行，聚合的绝对计数
  // 断言会被污染——先全清表，保证断言基线从 0 起算（deleteMany({}) 无 FK 依赖，直接清）。
  await prisma.userRequirement.deleteMany({});
  // 受控种子：4 条，覆盖多 status/priority/category，occurredAtTs 依次递增
  const now = Date.now();
  const rows = [
    { verbatimQuote: `${seedQuotePrefix}r1`, category: '教学问题', priority: 'high', status: 'new', occurredAtTs: new Date(now - 4 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r2`, category: '教学问题', priority: 'normal', status: 'new', occurredAtTs: new Date(now - 3 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r3`, category: '系统建议', priority: 'low', status: 'done', occurredAtTs: new Date(now - 2 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r4`, category: '教学问题', priority: 'urgent', status: 'triaged', occurredAtTs: new Date(now - 1 * 60 * 60 * 1000) },
  ];
  for (const row of rows) {
    const created = await prisma.userRequirement.create({ data: row });
    seededIds.push(created.id);
  }
});

afterAll(async () => {
  await prisma.userRequirement.deleteMany({ where: { id: { in: seededIds } } });
  await prisma.$disconnect();
});

describe('getFeedbackSummary 聚合', () => {
  it('total/byStatus/byPriority/byCategory/recent 全部正确', async () => {
    const result = await getFeedbackSummary(prisma, { limit: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value;

    expect(summary.total).toBe(4);
    expect(summary.byStatus).toEqual([
      { status: 'new', count: 2 },
      { status: 'triaged', count: 1 },
      { status: 'done', count: 1 },
    ]);
    // priority 规范序：严重度降序 urgent→high→normal→low
    expect(summary.byPriority).toEqual([
      { priority: 'urgent', count: 1 },
      { priority: 'high', count: 1 },
      { priority: 'normal', count: 1 },
      { priority: 'low', count: 1 },
    ]);
    // category 按 count 降序（并列 category 升序）
    expect(summary.byCategory).toEqual([
      { category: '教学问题', count: 3 },
      { category: '系统建议', count: 1 },
    ]);
    // recent 按 occurredAtTs 降序：r4 最新
    expect(summary.recent).toHaveLength(4);
    expect(summary.recent[0].id).toBe(seededIds[3]);
    expect(summary.recent[0].status).toBe('triaged');
    expect(summary.recent[3].id).toBe(seededIds[0]);
    expect(new Date(summary.recent[0].occurredAtTs).getTime()).toBeGreaterThan(
      new Date(summary.recent[3].occurredAtTs).getTime(),
    );
  });

  it('limit 生效：limit=2 → recent 仅 2 条', async () => {
    const result = await getFeedbackSummary(prisma, { limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recent).toHaveLength(2);
    expect(result.value.total).toBe(4); // total 不受 limit 影响
  });

  it('limit 非法（0/101/1.5）→ VALIDATION_ERROR', async () => {
    for (const limit of [0, 101, 1.5, -3]) {
      const result = await getFeedbackSummary(prisma, { limit });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.field).toBe('limit');
    }
  });

  it('库未就绪（groupBy 抛 DB 类错误）→ DATABASE_NOT_READY', async () => {
    const stub = {
      userRequirement: {
        count: async () => { throw new Error('connection refused: postgres'); },
        groupBy: async () => { throw new Error('connection refused: postgres'); },
        findMany: async () => { throw new Error('connection refused: postgres'); },
      },
    };
    const result = await getFeedbackSummary(stub as never, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DATABASE_NOT_READY');
  });
});

describe('GET /api/v1/admin/feedback/summary 路由', () => {
  it('未登录 → 401', async () => {
    const app = createAdminApp();
    const res = await request(app).get('/api/v1/admin/feedback/summary');
    expect(res.status).toBe(401);
  });

  it('登录后 → 200 聚合；limit=1 → recent 1 条；limit=0 → 400', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);

    const res = await agent.get('/api/v1/admin/feedback/summary');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.total).toBe(4);
    expect(res.body.data.byCategory[0]).toEqual({ category: '教学问题', count: 3 });
    expect(res.body.data.recent[0].id).toBe(seededIds[3]);

    const limited = await agent.get('/api/v1/admin/feedback/summary').query({ limit: 1 });
    expect(limited.status).toBe(200);
    expect(limited.body.data.recent).toHaveLength(1);

    const bad = await agent.get('/api/v1/admin/feedback/summary').query({ limit: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});
