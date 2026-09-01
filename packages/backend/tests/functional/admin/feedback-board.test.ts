import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAdminAuthService,
  createAdminRouter,
  feedbackActionForChanges,
  getFeedbackBoardDetail,
  hashAdminPassword,
  listFeedbackBoard,
  updateFeedbackBoard,
} from '../../../src/features/admin/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import { loadDatabaseUrl } from '../../../../ops/lib/pg-utils.mjs';
import { createDatabaseClientPool } from '../../../src/shared/database-pool/index.js';

/**
 * 反馈看板操作面（P8 续篇 · §九）单测：
 * - listFeedbackBoard：分页 + status/priority 过滤 + category 自由过滤 + 校验（page/pageSize/status/priority）
 * - getFeedbackBoardDetail：存在 → 全字段；不存在 → NOT_FOUND
 * - updateFeedbackBoard：状态流转（new→triaged→in_progress→done→archived）+ 关联字段；
 *   乐观锁 stale → VERSION_CONFLICT；白名单校验；verbatimQuote 不可改；平台级记录 admin 可写
 * - feedbackActionForChanges：语义化审计动作名（triage/schedule/complete/archive/link/update）
 * - 路由：未登录 401；登录后列表/详情/PATCH 全链路 + AdminAuditLog 落库断言
 * 隔离库由 run-tests-isolated.mjs 创建并 drop，本文件只写共享表（不建 teacher_db_*）。
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());

const seedQuotePrefix = `fb-board-${Date.now()}-`;
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
  // 其它测试（requirements 域、feedback 工具等）的 UserRequirement 行，列表/详情的绝对
  // 计数断言会被污染——先全清表，保证断言基线从 0 起算（deleteMany({}) 无 FK 依赖，直接清）。
  // AdminAuditLog 同 actor 残留同样先清（本文件断言 feedback.* 审计行，findFirst 需基线干净）。
  await prisma.userRequirement.deleteMany({});
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: ADMIN_EMAIL } });
  // 受控种子：5 条，覆盖多 status/priority/category（含中英文分类），occurredAtTs 依次递增
  const now = Date.now();
  const rows = [
    { verbatimQuote: `${seedQuotePrefix}r1`, category: 'feature', priority: 'high', status: 'new', occurredAtTs: new Date(now - 5 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r2`, category: '教学问题', priority: 'normal', status: 'new', occurredAtTs: new Date(now - 4 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r3`, category: 'bug_report', priority: 'low', status: 'in_progress', occurredAtTs: new Date(now - 3 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r4`, category: '系统建议', priority: 'urgent', status: 'triaged', occurredAtTs: new Date(now - 2 * 60 * 60 * 1000) },
    { verbatimQuote: `${seedQuotePrefix}r5`, category: 'improvement', priority: 'normal', status: 'done', occurredAtTs: new Date(now - 1 * 60 * 60 * 1000) },
  ];
  for (const row of rows) {
    const created = await prisma.userRequirement.create({ data: row });
    seededIds.push(created.id);
  }
});

afterAll(async () => {
  await prisma.userRequirement.deleteMany({ where: { id: { in: seededIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: ADMIN_EMAIL } });
  await prisma.$disconnect();
});

describe('listFeedbackBoard 列表', () => {
  it('默认分页：全部 5 条，occurredAtTs 降序', async () => {
    const result = await listFeedbackBoard(prisma, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(5);
    expect(result.value.items).toHaveLength(5);
    expect(result.value.items[0].id).toBe(seededIds[4]); // r5 最新
    expect(result.value.items[4].id).toBe(seededIds[0]);
  });

  it('status 过滤 + 分页（pageSize=2）', async () => {
    const result = await listFeedbackBoard(prisma, { status: 'new', page: 1, pageSize: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2); // r1/r2
    expect(result.value.items).toHaveLength(2);
  });

  it('priority 过滤', async () => {
    const result = await listFeedbackBoard(prisma, { priority: 'normal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2); // r2/r5
  });

  it('category 自由字符串过滤（中英文均可）', async () => {
    const cn = await listFeedbackBoard(prisma, { category: '教学问题' });
    expect(cn.ok).toBe(true);
    if (!cn.ok) return;
    expect(cn.value.total).toBe(1);

    const en = await listFeedbackBoard(prisma, { category: 'feature' });
    expect(en.ok).toBe(true);
    if (!en.ok) return;
    expect(en.value.total).toBe(1);
  });

  it('组合过滤：status+priority', async () => {
    const result = await listFeedbackBoard(prisma, { status: 'done', priority: 'normal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items[0].id).toBe(seededIds[4]);
  });

  it('校验：status/priority 非法 → VALIDATION_ERROR；page/pageSize 非法 → VALIDATION_ERROR', async () => {
    for (const input of [{ status: 'bogus' }, { priority: 'bogus' }, { page: 0 }, { pageSize: 101 }, { pageSize: 1.5 }]) {
      const result = await listFeedbackBoard(prisma, input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('库未就绪 → DATABASE_NOT_READY', async () => {
    const stub = {
      userRequirement: {
        findMany: async () => { throw new Error('connection refused: postgres'); },
        count: async () => { throw new Error('connection refused: postgres'); },
      },
    };
    const result = await listFeedbackBoard(stub as never, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DATABASE_NOT_READY');
  });
});

describe('getFeedbackBoardDetail 详情', () => {
  it('存在 → 全字段（含 verbatimQuote/updatedAtTs）', async () => {
    const result = await getFeedbackBoardDetail(prisma, seededIds[3]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(seededIds[3]);
    expect(result.value.verbatimQuote).toBe(`${seedQuotePrefix}r4`);
    expect(result.value.status).toBe('triaged');
    expect(result.value.updatedAtTs).toBeTruthy();
  });

  it('不存在 → NOT_FOUND', async () => {
    const result = await getFeedbackBoardDetail(prisma, 'clx_does_not_exist');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('updateFeedbackBoard 管理动作（评估/排期/关联）', () => {
  it('状态流转 new→triaged（评估）→ in_progress（排期）→ done（完成），乐观锁逐跳生效', async () => {
    // 初始 new
    const before = await getFeedbackBoardDetail(prisma, seededIds[0]);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.status).toBe('new');
    const lock0 = before.value.updatedAtTs;

    // 评估：new→triaged
    const triage = await updateFeedbackBoard(prisma, {
      requirementId: seededIds[0],
      expectedUpdatedAt: lock0,
      changes: { status: 'triaged', parsedIntent: '教师需要出勤趋势图' },
    });
    expect(triage.ok).toBe(true);
    if (!triage.ok) return;
    expect(triage.value.status).toBe('triaged');
    expect(triage.value.parsedIntent).toBe('教师需要出勤趋势图');
    const lock1 = triage.value.updatedAtTs;

    // 排期：triaged→in_progress + 关联任务
    const schedule = await updateFeedbackBoard(prisma, {
      requirementId: seededIds[0],
      expectedUpdatedAt: lock1,
      changes: { status: 'in_progress', linkedTaskId: 'T-101', linkedDesignDoc: 'reports/architecture/demo.md' },
    });
    expect(schedule.ok).toBe(true);
    if (!schedule.ok) return;
    expect(schedule.value.status).toBe('in_progress');
    expect(schedule.value.linkedTaskId).toBe('T-101');
    expect(schedule.value.linkedDesignDoc).toBe('reports/architecture/demo.md');
    const lock2 = schedule.value.updatedAtTs;

    // 完成：in_progress→done + 关联提交
    const complete = await updateFeedbackBoard(prisma, {
      requirementId: seededIds[0],
      expectedUpdatedAt: lock2,
      changes: { status: 'done', linkedCommitSha: 'abc123def' },
    });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    expect(complete.value.status).toBe('done');
    expect(complete.value.linkedCommitSha).toBe('abc123def');

    // 回滚造数（保持后续用例确定性）
    await prisma.userRequirement.update({
      where: { id: seededIds[0] },
      data: { status: 'new', parsedIntent: null, linkedTaskId: null, linkedDesignDoc: null, linkedCommitSha: null },
    });
  });

  it('乐观锁 stale → VERSION_CONFLICT；不存在 → NOT_FOUND', async () => {
    const before = await getFeedbackBoardDetail(prisma, seededIds[1]);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const stale = await updateFeedbackBoard(prisma, {
      requirementId: seededIds[1],
      expectedUpdatedAt: new Date(new Date(before.value.updatedAtTs).getTime() - 1000).toISOString(),
      changes: { status: 'triaged' },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('VERSION_CONFLICT');

    const missing = await updateFeedbackBoard(prisma, {
      requirementId: 'clx_does_not_exist',
      expectedUpdatedAt: before.value.updatedAtTs,
      changes: { status: 'triaged' },
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');
  });

  it('白名单校验：status/priority 非法 → VALIDATION_ERROR；expectedUpdatedAt 非 RFC3339 → VALIDATION_ERROR', async () => {
    const before = await getFeedbackBoardDetail(prisma, seededIds[2]);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    for (const changes of [{ status: 'bogus' }, { priority: 'bogus' }]) {
      const result = await updateFeedbackBoard(prisma, {
        requirementId: seededIds[2],
        expectedUpdatedAt: before.value.updatedAtTs,
        changes,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
    const badTime = await updateFeedbackBoard(prisma, {
      requirementId: seededIds[2],
      expectedUpdatedAt: '2026-08-21T00:00:00', // 无时区
      changes: { status: 'triaged' },
    });
    expect(badTime.ok).toBe(false);
    if (badTime.ok) return;
    expect(badTime.error.code).toBe('VALIDATION_ERROR');
    expect(badTime.error.field).toBe('expectedUpdatedAt');
  });

  it('admin 可更新平台级（teacherId=null）记录（管理权限高于教师侧 owner 隔离）', async () => {
    const platform = await prisma.userRequirement.create({
      data: {
        teacherId: null,
        verbatimQuote: `${seedQuotePrefix}platform`,
        category: 'privacy',
        occurredAtTs: new Date(),
      },
    });
    seededIds.push(platform.id);

    const result = await updateFeedbackBoard(prisma, {
      requirementId: platform.id,
      expectedUpdatedAt: platform.updatedAtTs.toISOString(),
      changes: { status: 'triaged' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('triaged');

    // 立即回滚（避免污染后续路由用例的 status 过滤计数）
    await prisma.userRequirement.update({
      where: { id: platform.id },
      data: { status: 'archived' },
    });
  });
});

describe('feedbackActionForChanges 审计动作名', () => {
  it('语义化：triage/schedule/complete/archive/link/update', () => {
    expect(feedbackActionForChanges({ status: 'triaged' })).toBe('feedback.triage');
    expect(feedbackActionForChanges({ status: 'in_progress' })).toBe('feedback.schedule');
    expect(feedbackActionForChanges({ status: 'done' })).toBe('feedback.complete');
    expect(feedbackActionForChanges({ status: 'archived' })).toBe('feedback.archive');
    expect(feedbackActionForChanges({ status: 'new' })).toBe('feedback.update');
    expect(feedbackActionForChanges({ linkedTaskId: 'T-1' })).toBe('feedback.link');
    expect(feedbackActionForChanges({ priority: 'high' })).toBe('feedback.update');
  });
});

describe('路由：GET/PATCH /api/v1/admin/feedback', () => {
  it('未登录 → 401（列表/详情/PATCH）', async () => {
    const app = createAdminApp();
    expect((await request(app).get('/api/v1/admin/feedback')).status).toBe(401);
    expect((await request(app).get(`/api/v1/admin/feedback/${seededIds[0]}`)).status).toBe(401);
    expect((await request(app).patch(`/api/v1/admin/feedback/${seededIds[0]}`).send({})).status).toBe(401);
  });

  it('登录后：列表过滤 + 详情 + PATCH 评估 → 审计 feedback.triage 落库', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);

    // 列表 + status 过滤
    const list = await agent.get('/api/v1/admin/feedback').query({ status: 'triaged' });
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0].id).toBe(seededIds[3]);

    // 非法过滤 → 400
    const bad = await agent.get('/api/v1/admin/feedback').query({ status: 'bogus' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    // 详情
    const detail = await agent.get(`/api/v1/admin/feedback/${seededIds[3]}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.verbatimQuote).toBe(`${seedQuotePrefix}r4`);

    // PATCH 评估（r3: in_progress → triaged 不合规语义，用 priority 单独更新 + link）
    const detailR3 = await agent.get(`/api/v1/admin/feedback/${seededIds[2]}`);
    const r3Lock = detailR3.body.data.updatedAtTs as string;
    const patch = await agent
      .patch(`/api/v1/admin/feedback/${seededIds[2]}`)
      .send({ expectedUpdatedAt: r3Lock, changes: { linkedTaskId: 'T-202', status: 'done' } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.status).toBe('done');
    expect(patch.body.data.linkedTaskId).toBe('T-202');

    // 审计落库：action=feedback.complete（status→done 语义）
    const audit = await prisma.adminAuditLog.findFirst({
      where: { actorEmail: ADMIN_EMAIL, objectId: seededIds[2], action: 'feedback.complete' },
      orderBy: { createdAtTs: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.detail).toMatchObject({ changes: { linkedTaskId: 'T-202', status: 'done' } });

    // PATCH 失败 → feedback.*.failed 落库（stale 409）
    const stale = await agent
      .patch(`/api/v1/admin/feedback/${seededIds[2]}`)
      .send({ expectedUpdatedAt: new Date(new Date(r3Lock).getTime() - 1000).toISOString(), changes: { status: 'archived' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const failedAudit = await prisma.adminAuditLog.findFirst({
      where: { actorEmail: ADMIN_EMAIL, objectId: seededIds[2], action: 'feedback.archive.failed' },
      orderBy: { createdAtTs: 'desc' },
    });
    expect(failedAudit).not.toBeNull();

    // PATCH 非法 changes 字段 → 400（verbatimQuote 不可改）
    const verbatim = await agent
      .patch(`/api/v1/admin/feedback/${seededIds[3]}`)
      .send({ expectedUpdatedAt: detail.body.data.updatedAtTs, changes: { verbatimQuote: '篡改原话' } });
    expect(verbatim.status).toBe(400);
    expect(verbatim.body.error.code).toBe('VALIDATION_ERROR');

    // 回滚造数（保持确定性）
    await prisma.userRequirement.update({
      where: { id: seededIds[2] },
      data: { status: 'in_progress', linkedTaskId: null },
    });
  });
});
