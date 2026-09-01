import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';

const prisma = new PrismaClient();
const app = createApp(prisma);

const createdIds: string[] = [];
const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.userRequirement.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

async function ensureTeacher(id: string): Promise<void> {
  const existing = await prisma.teacherRegistry.findUnique({ where: { id } });
  if (existing) return;
  await prisma.teacherRegistry.create({
    data: { id, email: `${id}@example.com`, passwordHash: 'test-hash', displayName: id },
  });
  createdTeacherIds.push(id);
}

function uniqueQuote(prefix = 'req-e2e'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

describe('UserRequirement HTTP API（P2）', () => {
  it('POST /requirements 创建（带 x-teacher-id 归属教师）→ 201；GET 列表 owner 可见', async () => {
    await ensureTeacher('req-e2e-teacher');
    const quote = uniqueQuote();
    const create = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-e2e-teacher')
      .send({
        verbatimQuote: quote,
        category: 'feature',
        priority: 'high',
        occurredAtTs: '2026-08-21T00:00:00.000Z',
      });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    expect(create.body.data.teacherId).toBe('req-e2e-teacher');
    expect(create.body.data.priority).toBe('high');
    expect(create.body.data.status).toBe('new');
    createdIds.push(create.body.data.id);

    const list = await request(app)
      .get('/api/v1/requirements')
      .set('x-teacher-id', 'req-e2e-teacher');
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.data.items.some((item: { verbatimQuote: string }) => item.verbatimQuote === quote)).toBe(true);
  });

  it('POST 校验：非法分类 → 400（带 x-teacher-id）', async () => {
    await ensureTeacher('req-e2e-invalid');
    const res = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-e2e-invalid')
      .send({ verbatimQuote: uniqueQuote(), category: 'invalid-category' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST 写路径强制身份：无 session/无 x-teacher-id → 401（P0 IDOR 修复：身份唯一来源 = requireAuth 注入）', async () => {
    const res = await request(app)
      .post('/api/v1/requirements')
      .send({ verbatimQuote: uniqueQuote(), category: 'feature' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('PATCH /requirements/:id 乐观锁：stale → 409；正确 → 200 更新', async () => {
    await ensureTeacher('req-e2e-patch');
    const create = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-e2e-patch')
      .send({ verbatimQuote: uniqueQuote(), category: 'improvement' });
    expect(create.status).toBe(201);
    const id = create.body.data.id;
    createdIds.push(id);

    const createdAtMs = new Date(create.body.data.updatedAtTs).getTime();
    const stale = await request(app)
      .patch(`/api/v1/requirements/${id}`)
      .set('x-teacher-id', 'req-e2e-patch')
      .send({ expectedUpdatedAt: new Date(createdAtMs - 1000).toISOString(), changes: { status: 'triaged' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const ok = await request(app)
      .patch(`/api/v1/requirements/${id}`)
      .set('x-teacher-id', 'req-e2e-patch')
      .send({ expectedUpdatedAt: create.body.data.updatedAtTs, changes: { status: 'triaged', linkedTaskId: 'T-1' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('triaged');
    expect(ok.body.data.linkedTaskId).toBe('T-1');
  });

  it('PATCH 平台级记录被任意教师 → 404（越权修复）；列表仍可读平台级（读语义保留）', async () => {
    await ensureTeacher('req-e2e-platform');
    // 平台级记录由平台/管理员维护，直接 DB 插入模拟平台侧写入
    const platform = await prisma.userRequirement.create({
      data: { teacherId: null, verbatimQuote: uniqueQuote('platform'), category: 'privacy', occurredAtTs: new Date('2026-08-01T00:00:00.000Z') },
    });
    createdIds.push(platform.id);

    // 教师列表可见平台级需求（设计语义：平台级需求教师只读）
    const list = await request(app)
      .get('/api/v1/requirements?category=privacy')
      .set('x-teacher-id', 'req-e2e-platform');
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.data.items.some((item: { id: string }) => item.id === platform.id)).toBe(true);

    // 教师 PATCH 平台级 → 404 NOT_FOUND（qa3 复测场景）
    const denied = await request(app)
      .patch(`/api/v1/requirements/${platform.id}`)
      .set('x-teacher-id', 'req-e2e-platform')
      .send({ expectedUpdatedAt: platform.updatedAtTs.toISOString(), changes: { status: 'triaged', linkedTaskId: 'T-99' } });
    expect(denied.status).toBe(404);
    expect(denied.body.ok).toBe(false);
    expect(denied.body.error.code).toBe('NOT_FOUND');

    // 记录未被修改
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: platform.id } });
    expect(persisted.status).toBe('new');
    expect(persisted.linkedTaskId).toBeNull();
  });

  it('PATCH 他人 owner 记录 → 404（跨 teacher 惯例防探测）', async () => {
    await ensureTeacher('req-e2e-cross-a');
    await ensureTeacher('req-e2e-cross-b');
    const create = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-e2e-cross-a')
      .send({ verbatimQuote: uniqueQuote(), category: 'improvement' });
    expect(create.status).toBe(201);
    const id = create.body.data.id;
    createdIds.push(id);

    const crossed = await request(app)
      .patch(`/api/v1/requirements/${id}`)
      .set('x-teacher-id', 'req-e2e-cross-b')
      .send({ expectedUpdatedAt: create.body.data.updatedAtTs, changes: { status: 'triaged' } });
    expect(crossed.status).toBe(404);
    expect(crossed.body.ok).toBe(false);
    expect(crossed.body.error.code).toBe('NOT_FOUND');
  });
});

describe('requirements.capture Agent 工具（P2）', () => {
  it('工具已注册（副作用 create，schema 含 verbatimQuote/category）', () => {
    const registry = createMinimalToolRegistry({ prisma });
    const tool = registry.list().find((item) => item.name === 'requirements.capture');
    expect(tool).toBeDefined();
    expect(tool!.sideEffect).toBe('create');
    expect((tool!.parameters as { properties: Record<string, unknown> }).properties.verbatimQuote).toBeDefined();
    expect((tool!.parameters as { required: string[] }).required).toContain('verbatimQuote');
    expect((tool!.parameters as { required: string[] }).required).toContain('category');
  });

  it('执行 capture：创建需求并返回 requirementId', async () => {
    await ensureTeacher('req-e2e-tool');
    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute(
      'requirements.capture',
      { verbatimQuote: '老师希望看到学生出勤率趋势图', category: 'feature', priority: 'high' },
      { teacherId: 'req-e2e-tool' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { requirementId: string };
    expect(value.requirementId).toBeDefined();
    createdIds.push(value.requirementId);

    const record = await prisma.userRequirement.findUnique({ where: { id: value.requirementId } });
    expect(record).not.toBeNull();
    expect(record!.teacherId).toBe('req-e2e-tool');
    expect(record!.category).toBe('feature');
    expect(record!.priority).toBe('high');
    expect(record!.sourceType).toBe('agent_conversation');
  });

  it('执行校验：缺 verbatimQuote → error', async () => {
    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute(
      'requirements.capture',
      { category: 'feature' },
      { teacherId: 'req-e2e-tool' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
