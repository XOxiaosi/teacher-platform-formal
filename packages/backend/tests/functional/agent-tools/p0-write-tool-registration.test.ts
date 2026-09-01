import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Phase 4.2-A: 红灯测试
// createMinimalToolRegistry 当前尚未注册低风险写工具。
// 本测试锁定 students.create / scheduling.create / payments.create 的注册与基础参数校验契约。

let createMinimalToolRegistry: unknown;
try {
  const mod = await import('../../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

function requireRegistryFactory() {
  if (!createMinimalToolRegistry) {
    throw new Error('createMinimalToolRegistry export is missing');
  }
  return createMinimalToolRegistry as (options: {
    prisma: PrismaClient;
    trustedClock?: {
      now(): Promise<{ ok: boolean; value?: Date; error?: { code: string; message: string } }>;
    };
  }) => {
    list(): Array<{ name: string }>;
    execute(name: string, args: unknown, context: { teacherId: string }): Promise<{ ok: boolean; value?: unknown; error?: { code: string; field?: string } }>;
  };
}

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-p0-write-a';
const TEACHER_B = 'test-teacher-p0-write-b';

async function cleanup() {
  const teacherIds = [TEACHER_A, TEACHER_B];
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('P0 低风险写工具注册契约（Phase 4.2-A 红灯）', () => {
  it('registry.list 包含 students.create / scheduling.create / payments.create', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).toContain('students.create');
    expect(toolNames).toContain('scheduling.create');
    expect(toolNames).toContain('payments.create');
  });

  it('students.create 创建当前 teacher 学生', async () => {
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('students.create', {
      name: '新学生',
      grade: '高一',
      source: 'agent',
      stageGoal: '稳定提升力学基础',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`students.create failed: ${result.error?.code}`);
    const data = result.value as { teacherId: string; name: string; grade: string; source: string | null; stageGoal: string | null };
    expect(data.teacherId).toBe(TEACHER_A);
    expect(data.name).toBe('新学生');
    expect(data.grade).toBe('高一');
    expect(data.source).toBe('agent');
    expect(data.stageGoal).toBe('稳定提升力学基础');

    const created = await prisma.student.findMany({ where: { teacherId: TEACHER_A } });
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('新学生');
  });

  it('students.create 缺少 name 或 grade 返回 VALIDATION_ERROR', async () => {
    const registry = requireRegistryFactory()({ prisma });

    const missingName = await registry.execute('students.create', { grade: '高一' }, { teacherId: TEACHER_A });
    expect(missingName.ok).toBe(false);
    if (missingName.ok) throw new Error('students.create unexpectedly succeeded without name');
    expect(missingName.error?.code).toBe('VALIDATION_ERROR');
    expect(missingName.error?.field).toBe('name');

    const missingGrade = await registry.execute('students.create', { name: '新学生' }, { teacherId: TEACHER_A });
    expect(missingGrade.ok).toBe(false);
    if (missingGrade.ok) throw new Error('students.create unexpectedly succeeded without grade');
    expect(missingGrade.error?.code).toBe('VALIDATION_ERROR');
    expect(missingGrade.error?.field).toBe('grade');
  });

  it('scheduling.create 创建当前 teacher 日程并返回 conflicts 结构', async () => {
    const student = await createStudentFixture(TEACHER_A, '日程学生');
    const registry = requireRegistryFactory()({
      prisma,
      trustedClock: {
        now: async () => ({ ok: true, value: new Date('2026-07-19T00:00:00.000Z') }),
      },
    });
    const scheduledStart = '2026-07-20T10:00:00.000Z';
    const scheduledEnd = '2026-07-20T11:30:00.000Z';

    const result = await registry.execute('scheduling.create', {
      studentId: student.id,
      type: 'lesson',
      title: '物理一对一',
      scheduledStart,
      scheduledEnd,
      confidence: 'high',
      sourceInput: '用户口述新增课程',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`scheduling.create failed: ${result.error?.code}`);
    const data = result.value as { schedule: { teacherId: string; studentId: string | null; type: string; title: string; scheduledStart: Date | string; scheduledEnd: Date | string }; conflicts: unknown[] };
    expect(data.schedule.teacherId).toBe(TEACHER_A);
    expect(data.schedule.studentId).toBe(student.id);
    expect(data.schedule.type).toBe('lesson');
    expect(data.schedule.title).toBe('物理一对一');
    expect(new Date(data.schedule.scheduledStart).toISOString()).toBe(scheduledStart);
    expect(new Date(data.schedule.scheduledEnd).toISOString()).toBe(scheduledEnd);
    expect(Array.isArray(data.conflicts)).toBe(true);
  });

  it('scheduling.create 接受带 +08:00 的未来时间并保存同一 instant', async () => {
    const registry = requireRegistryFactory()({
      prisma,
      trustedClock: {
        now: async () => ({ ok: true, value: new Date('2026-07-19T00:00:00.000Z') }),
      },
    });

    const result = await registry.execute('scheduling.create', {
      type: 'lesson',
      title: '上海时区物理课',
      scheduledStart: '2026-07-20T16:00:00+08:00',
      scheduledEnd: '2026-07-20T18:00:00+08:00',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`scheduling.create failed: ${result.error?.code}`);
    const created = await prisma.schedule.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(created.scheduledStartTs.toISOString()).toBe('2026-07-20T08:00:00.000Z');
    expect(created.scheduledEndTs.toISOString()).toBe('2026-07-20T10:00:00.000Z');
  });

  it('scheduling.create 缺少必要字段或非法时间返回 VALIDATION_ERROR', async () => {
    const registry = requireRegistryFactory()({ prisma });
    const base = { type: 'lesson', title: '物理课', scheduledStart: '2026-07-20T10:00:00.000Z', scheduledEnd: '2026-07-20T11:30:00.000Z' };

    const missingTitle = await registry.execute('scheduling.create', { ...base, title: '' }, { teacherId: TEACHER_A });
    expect(missingTitle.ok).toBe(false);
    if (missingTitle.ok) throw new Error('scheduling.create unexpectedly succeeded without title');
    expect(missingTitle.error?.code).toBe('VALIDATION_ERROR');
    expect(missingTitle.error?.field).toBe('title');

    const missingType = await registry.execute('scheduling.create', { title: '物理课', scheduledStart: base.scheduledStart, scheduledEnd: base.scheduledEnd }, { teacherId: TEACHER_A });
    expect(missingType.ok).toBe(false);
    if (missingType.ok) throw new Error('scheduling.create unexpectedly succeeded without type');
    expect(missingType.error?.code).toBe('VALIDATION_ERROR');
    expect(missingType.error?.field).toBe('type');

    const invalidStart = await registry.execute('scheduling.create', { ...base, scheduledStart: 'bad-date' }, { teacherId: TEACHER_A });
    expect(invalidStart.ok).toBe(false);
    if (invalidStart.ok) throw new Error('scheduling.create unexpectedly succeeded with invalid start');
    expect(invalidStart.error?.code).toBe('VALIDATION_ERROR');
    expect(invalidStart.error?.field).toBe('scheduledStart');

    const invalidRange = await registry.execute('scheduling.create', { ...base, scheduledEnd: '2026-07-20T09:00:00.000Z' }, { teacherId: TEACHER_A });
    expect(invalidRange.ok).toBe(false);
    if (invalidRange.ok) throw new Error('scheduling.create unexpectedly succeeded with invalid range');
    expect(invalidRange.error?.code).toBe('VALIDATION_ERROR');
    expect(invalidRange.error?.field).toBe('scheduledEnd');
  });

  it.each([
    {
      field: 'scheduledStart',
      scheduledStart: '2030-07-20T16:00:00',
      scheduledEnd: '2030-07-21T18:00:00+08:00',
    },
    {
      field: 'scheduledEnd',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00',
    },
  ])('scheduling.create 拒绝缺少时区 offset 的 $field 且零写入', async ({ field, scheduledStart, scheduledEnd }) => {
    const registry = requireRegistryFactory()({
      prisma,
      trustedClock: {
        now: async () => ({ ok: true, value: new Date('2030-07-19T00:00:00.000Z') }),
      },
    });

    const result = await registry.execute('scheduling.create', {
      type: 'lesson',
      title: '缺少时区的计划课',
      scheduledStart,
      scheduledEnd,
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('scheduling.create unexpectedly accepted a timezone-less instant');
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.field).toBe(field);
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('scheduling.create 使用可信时钟拒绝过去的 planned 日程且零写入', async () => {
    const trustedClock = {
      now: async () => ({ ok: true, value: new Date('2026-07-20T04:00:00.000Z') }),
    };
    const registry = requireRegistryFactory()({ prisma, trustedClock });

    const result = await registry.execute('scheduling.create', {
      type: 'lesson',
      title: '已经过去的计划课',
      scheduledStart: '2026-07-20T10:00:00+08:00',
      scheduledEnd: '2026-07-20T11:00:00+08:00',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('scheduling.create unexpectedly created a past planned schedule');
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.field).toBe('scheduledStart');
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('scheduling.create 在可信时钟不可用时 fail-closed 且零写入', async () => {
    const trustedClock = {
      now: async () => ({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '数据库可信时间不可用' },
      }),
    };
    const registry = requireRegistryFactory()({ prisma, trustedClock });

    const result = await registry.execute('scheduling.create', {
      type: 'lesson',
      title: '无法判断当前时间的计划课',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('scheduling.create unexpectedly wrote without trusted time');
    expect(result.error?.code).toBe('INTERNAL_ERROR');
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('scheduling.create 拒绝关联其他 teacher 的学生；payments.create 跨老师 fail-closed', async () => {
    const otherStudent = await createStudentFixture(TEACHER_B, '其他老师学生');
    const registry = requireRegistryFactory()({
      prisma,
      trustedClock: {
        now: async () => ({ ok: true, value: new Date('2030-07-19T00:00:00.000Z') }),
      },
    });

    const scheduleResult = await registry.execute('scheduling.create', {
      studentId: otherStudent.id,
      type: 'lesson',
      title: '跨老师 Agent 课程',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    }, { teacherId: TEACHER_A });
    // P29-W1：payments.create 已改 confirmation:required，direct execute 固定 fail-closed
    const paymentResult = await registry.execute('payments.create', {
      studentId: otherStudent.id,
      amount: 1200,
      lessonCount: 10,
      paidAt: '2030-07-20T10:00:00+08:00',
    }, { teacherId: TEACHER_A });

    expect(scheduleResult.ok).toBe(false);
    if (scheduleResult.ok) throw new Error('scheduling.create accepted another teacher student');
    expect(scheduleResult.error?.code).toBe('NOT_FOUND');
    expect(paymentResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('payments.create 声明 required，direct execute fail-closed 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '缴费学生');
    const registry = requireRegistryFactory()({ prisma });
    const definition = registry.list().find((tool) => tool.name === 'payments.create');

    expect(definition).toBeDefined();
    expect((definition as { confirmation?: string }).confirmation).toBe('required');

    const result = await registry.execute('payments.create', {
      studentId: student.id,
      amount: 1200,
      lessonCount: 10,
      paidAt: '2026-07-21T12:00:00.000Z',
      note: '暑期课包',
    }, { teacherId: TEACHER_A });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('payments.create 任意参数（缺 studentId/非法金额/非法课时/非法 paidAt/跨老师）都 fail-closed 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '缴费学生');
    const registry = requireRegistryFactory()({ prisma });
    const base = { studentId: student.id, amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' };

    const cases = [
      { amount: 1200, lessonCount: 10, paidAt: base.paidAt },
      { ...base, amount: 0 },
      { ...base, lessonCount: 0 },
      { ...base, paidAt: 'bad-date' },
    ];
    for (const args of cases) {
      const result = await registry.execute('payments.create', args, { teacherId: TEACHER_A });
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
      });
    }
    const crossed = await registry.execute('payments.create', base, { teacherId: TEACHER_B });
    expect(crossed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_B } })).toBe(0);
  });

  it('Phase 4.3 仍不注册未设计的回溯修正和删除工具', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).not.toContain('scheduling.update');
    expect(toolNames).not.toContain('scheduling.missed');
    expect(toolNames).not.toContain('lessons.update');
    expect(toolNames).not.toContain('students.update');
    expect(toolNames).not.toContain('payments.delete');
  });
});
