import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createRequirementService } from '../../../src/features/requirements/index.js';

const prisma = new PrismaClient();
const service = createRequirementService(prisma);

const createdIds: string[] = [];
const createdTeacherIds: string[] = [];

/** 建真实教师（UserRequirement.teacherId 有 FK → TeacherRegistry）。 */
async function ensureTeacher(id: string): Promise<void> {
  const existing = await prisma.teacherRegistry.findUnique({ where: { id } });
  if (existing) return;
  await prisma.teacherRegistry.create({
    data: { id, email: `${id}@example.com`, passwordHash: 'test-hash', displayName: id },
  });
  createdTeacherIds.push(id);
}

afterAll(async () => {
  await prisma.userRequirement.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function uniqueQuote(prefix = 'req-test'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function track(id: string): void {
  createdIds.push(id);
}

describe('RequirementService CRUD', () => {
  it('createRequirement 成功：默认 priority/status，occurredAtTs 缺省用 TrustedClock', async () => {
    await ensureTeacher('teacher-a');
    const result = await service.createRequirement({
      teacherId: 'teacher-a',
      verbatimQuote: uniqueQuote(),
      category: 'feature',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.category).toBe('feature');
    expect(result.value.priority).toBe('normal');
    expect(result.value.status).toBe('new');
    expect(result.value.occurredAtTs).toBeInstanceOf(Date);
    expect(result.value.teacherId).toBe('teacher-a');
    track(result.value.id);
  });

  it('createRequirement 校验：空原话/非法分类/非法优先级/非法状态', async () => {
    await ensureTeacher('teacher-validate');
    const emptyQuote = await service.createRequirement({ teacherId: 'teacher-validate', verbatimQuote: '  ', category: 'feature' });
    expect(emptyQuote.ok).toBe(false);
    if (emptyQuote.ok) return;
    expect(emptyQuote.error.code).toBe('VALIDATION_ERROR');
    expect(emptyQuote.error.field).toBe('verbatimQuote');

    const badCategory = await service.createRequirement({ teacherId: 'teacher-validate', verbatimQuote: uniqueQuote(), category: 'nope' });
    expect(badCategory.ok).toBe(false);

    const badPriority = await service.createRequirement({
      teacherId: 'teacher-validate',
      verbatimQuote: uniqueQuote(),
      category: 'feature',
      priority: 'urgentest',
    });
    expect(badPriority.ok).toBe(false);

    const badStatus = await service.createRequirement({
      teacherId: 'teacher-validate',
      verbatimQuote: uniqueQuote(),
      category: 'feature',
      status: 'done-skipped',
    });
    expect(badStatus.ok).toBe(false);
  });

  it('getRequirement：owner 隔离——教师可见自己的+平台级，不可见他人', async () => {
    await ensureTeacher('teacher-a');
    await ensureTeacher('teacher-b');
    const mine = await service.createRequirement({ teacherId: 'teacher-a', verbatimQuote: uniqueQuote(), category: 'ux' });
    // 平台级记录由平台/管理员维护，不走教师 API——测试直接 DB 插入模拟平台侧写入
    const platform = await prisma.userRequirement.create({
      data: { teacherId: null, verbatimQuote: uniqueQuote(), category: 'privacy', occurredAtTs: new Date('2026-08-01T00:00:00.000Z') },
    });
    const other = await service.createRequirement({ teacherId: 'teacher-b', verbatimQuote: uniqueQuote(), category: 'feature' });
    if (!mine.ok || !other.ok) return;
    track(mine.value.id);
    track(platform.id);
    track(other.value.id);

    const mineOk = await service.getRequirement({ requirementId: mine.value.id, teacherId: 'teacher-a' });
    expect(mineOk.ok).toBe(true);
    const platformOk = await service.getRequirement({ requirementId: platform.id, teacherId: 'teacher-a' });
    expect(platformOk.ok).toBe(true);
    const otherDenied = await service.getRequirement({ requirementId: other.value.id, teacherId: 'teacher-a' });
    expect(otherDenied.ok).toBe(false);
    if (otherDenied.ok) return;
    expect(otherDenied.error.code).toBe('NOT_FOUND');
  });

  it('listRequirements：owner 隔离 + status/category 过滤 + 分页', async () => {
    const teacher = 'teacher-list';
    await ensureTeacher(teacher);
    await service.createRequirement({ teacherId: teacher, verbatimQuote: uniqueQuote(), category: 'feature', status: 'new' });
    await service.createRequirement({ teacherId: teacher, verbatimQuote: uniqueQuote(), category: 'bug_report', status: 'triaged' });
    // 平台级记录由平台/管理员维护，测试直接 DB 插入模拟平台侧写入
    const platform = await prisma.userRequirement.create({
      data: { teacherId: null, verbatimQuote: uniqueQuote(), category: 'feature', status: 'done', occurredAtTs: new Date('2026-08-01T00:00:00.000Z') },
    });
    track(platform.id);

    const list = await service.listRequirements({ teacherId: teacher, page: 1, pageSize: 10 });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    // 教师看到自己的 2 条 + 平台级 1 条 = 3（可能含同 teacher 历史测试数据，至少含这 3 条）
    expect(list.value.total).toBeGreaterThanOrEqual(3);
    expect(list.value.items.every((item) => item.teacherId === teacher || item.teacherId === null)).toBe(true);

    const filtered = await service.listRequirements({ teacherId: teacher, status: 'new' });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.items.every((item) => item.status === 'new')).toBe(true);
  });

  it('PATCH 乐观锁：expectedUpdatedAt 不匹配 → VERSION_CONFLICT；匹配 → 更新且 verbatimQuote 不可改', async () => {
    await ensureTeacher('teacher-patch');
    const created = await service.createRequirement({
      teacherId: 'teacher-patch',
      verbatimQuote: uniqueQuote(),
      category: 'improvement',
      status: 'new',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    track(created.value.id);

    const stale = await service.updateRequirement({
      requirementId: created.value.id,
      teacherId: 'teacher-patch',
      expectedUpdatedAt: new Date(created.value.updatedAtTs.getTime() - 1000).toISOString(),
      changes: { status: 'triaged' },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('VERSION_CONFLICT');

    const okUpdate = await service.updateRequirement({
      requirementId: created.value.id,
      teacherId: 'teacher-patch',
      expectedUpdatedAt: created.value.updatedAtTs.toISOString(),
      changes: { status: 'triaged', priority: 'high', linkedTaskId: 'T-42' },
    });
    expect(okUpdate.ok).toBe(true);
    if (!okUpdate.ok) return;
    expect(okUpdate.value.status).toBe('triaged');
    expect(okUpdate.value.priority).toBe('high');
    expect(okUpdate.value.linkedTaskId).toBe('T-42');
    // verbatimQuote 不可改：PATCH changes 无此字段，原话保持
    expect(okUpdate.value.verbatimQuote).toBe(created.value.verbatimQuote);
  });

  it('PATCH 白名单：非法 status/category 拒绝', async () => {
    await ensureTeacher('teacher-whitelist');
    const created = await service.createRequirement({
      teacherId: 'teacher-whitelist',
      verbatimQuote: uniqueQuote(),
      category: 'feature',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    track(created.value.id);

    const bad = await service.updateRequirement({
      requirementId: created.value.id,
      teacherId: 'teacher-whitelist',
      expectedUpdatedAt: created.value.updatedAtTs.toISOString(),
      changes: { status: 'not-a-status' },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe('VALIDATION_ERROR');
  });

  it('createRequirement 写路径强制 owner：无 teacherId → VALIDATION_ERROR（教师不得创建平台级记录）', async () => {
    const missing = await service.createRequirement({ verbatimQuote: uniqueQuote(), category: 'feature' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('VALIDATION_ERROR');
    expect(missing.error.field).toBe('teacherId');

    const blank = await service.createRequirement({ teacherId: '   ', verbatimQuote: uniqueQuote(), category: 'feature' });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe('VALIDATION_ERROR');
    expect(blank.error.field).toBe('teacherId');
  });

  it('PATCH 平台级（teacherId=null）记录被任意教师修改 → NOT_FOUND（越权修复核心）', async () => {
    await ensureTeacher('teacher-a');
    // 平台级记录由平台维护，直接 DB 插入模拟平台侧写入
    const platform = await prisma.userRequirement.create({
      data: { teacherId: null, verbatimQuote: uniqueQuote(), category: 'privacy', occurredAtTs: new Date('2026-08-01T00:00:00.000Z') },
    });
    track(platform.id);

    const denied = await service.updateRequirement({
      requirementId: platform.id,
      teacherId: 'teacher-a',
      expectedUpdatedAt: platform.updatedAtTs.toISOString(),
      changes: { status: 'triaged', linkedTaskId: 'T-99' },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('NOT_FOUND');
    // 记录未被修改
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: platform.id } });
    expect(persisted.status).toBe('new');
    expect(persisted.linkedTaskId).toBeNull();
  });

  it('PATCH 他人 owner 记录 → NOT_FOUND（跨 teacher 惯例防探测）；teacherId 缺失 → NOT_FOUND', async () => {
    await ensureTeacher('teacher-a');
    await ensureTeacher('teacher-b');
    const mine = await service.createRequirement({ teacherId: 'teacher-a', verbatimQuote: uniqueQuote(), category: 'feature' });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    track(mine.value.id);

    const crossed = await service.updateRequirement({
      requirementId: mine.value.id,
      teacherId: 'teacher-b',
      expectedUpdatedAt: mine.value.updatedAtTs.toISOString(),
      changes: { status: 'triaged' },
    });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');

    const missingTeacher = await service.updateRequirement({
      requirementId: mine.value.id,
      expectedUpdatedAt: mine.value.updatedAtTs.toISOString(),
      changes: { status: 'triaged' },
    });
    expect(missingTeacher.ok).toBe(false);
    if (missingTeacher.ok) return;
    expect(missingTeacher.error.code).toBe('NOT_FOUND');
  });
});
