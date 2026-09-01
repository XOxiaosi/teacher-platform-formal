import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Phase 4.1-A: 红灯测试
// createMinimalToolRegistry 当前尚未注册完整 P0 只读工具。
// 本测试锁定 students.get / lessons.list / payments.list 的注册与 teacherId 隔离契约。

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
  return createMinimalToolRegistry as (options: { prisma: PrismaClient }) => {
    list(): Array<{ name: string }>;
    execute(name: string, args: unknown, context: { teacherId: string }): Promise<{ ok: boolean; value?: unknown; error?: { code: string; field?: string } }>;
  };
}

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-p0-read-a';
const TEACHER_B = 'test-teacher-p0-read-b';

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

async function createLessonFixture(input: { teacherId: string; studentId: string; date: Date; progress: string }) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      type: 'lesson',
      title: 'P0 只读工具测试课次',
      scheduledStartTs: input.date,
      scheduledEndTs: new Date(input.date.getTime() + 90 * 60 * 1000),
      status: 'completed',
    },
  });

  return prisma.lesson.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      scheduleId: schedule.id,
      dateTs: input.date,
      status: 'attended',
      progress: input.progress,
    },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('P0 只读工具注册契约（Phase 4.1-A 红灯）', () => {
  it('registry.list 包含 students.get / students.list / scheduling.list / lessons.list / payments.list', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).toContain('students.get');
    expect(toolNames).toContain('students.list');
    expect(toolNames).toContain('scheduling.list');
    expect(toolNames).toContain('lessons.list');
    expect(toolNames).toContain('payments.list');
  });

  it('students.get 返回当前 teacher 的学生详情', async () => {
    const student = await createStudentFixture(TEACHER_A, '张三');
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('students.get', { studentId: student.id }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`students.get failed: ${result.error?.code}`);
    const data = result.value as { id: string; teacherId: string; name: string };
    expect(data.id).toBe(student.id);
    expect(data.teacherId).toBe(TEACHER_A);
    expect(data.name).toBe('张三');
  });

  it('students.get 跨 teacher 读取返回 NOT_FOUND，不泄露学生详情', async () => {
    const student = await createStudentFixture(TEACHER_A, '隐私学生');
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('students.get', { studentId: student.id }, { teacherId: TEACHER_B });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('students.get unexpectedly succeeded across teacher boundary');
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(JSON.stringify(result)).not.toContain('隐私学生');
  });

  it('students.get 缺少 studentId 返回 VALIDATION_ERROR', async () => {
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('students.get', {}, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('students.get unexpectedly succeeded without studentId');
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.field).toBe('studentId');
  });

  it('lessons.list 只返回当前 teacher 课次，不泄露其他 teacher', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '学生A');
    const studentB = await createStudentFixture(TEACHER_B, '学生B');
    await createLessonFixture({ teacherId: TEACHER_A, studentId: studentA.id, date: new Date('2026-07-01T10:00:00.000Z'), progress: 'A 进度' });
    await createLessonFixture({ teacherId: TEACHER_B, studentId: studentB.id, date: new Date('2026-07-02T10:00:00.000Z'), progress: 'B 秘密进度' });
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('lessons.list', {}, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`lessons.list failed: ${result.error?.code}`);
    const data = result.value as { items: Array<{ teacherId: string; progress: string | null }>; total: number };
    expect(data.total).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].teacherId).toBe(TEACHER_A);
    expect(JSON.stringify(data)).toContain('A 进度');
    expect(JSON.stringify(data)).not.toContain('B 秘密进度');
  });

  it('payments.list 只返回当前 teacher 缴费记录，不泄露其他 teacher', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '学生A');
    const studentB = await createStudentFixture(TEACHER_B, '学生B');
    await prisma.payment.create({
      data: { teacherId: TEACHER_A, studentId: studentA.id, amount: 1200, lessonCount: 10, paidAtTs: new Date('2026-07-01T10:00:00.000Z'), note: 'A 付款' },
    });
    await prisma.payment.create({
      data: { teacherId: TEACHER_B, studentId: studentB.id, amount: 9999, lessonCount: 99, paidAtTs: new Date('2026-07-02T10:00:00.000Z'), note: 'B 秘密付款' },
    });
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('payments.list', {}, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`payments.list failed: ${result.error?.code}`);
    const data = result.value as { items: Array<{ teacherId: string; note: string | null }>; total: number };
    expect(data.total).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].teacherId).toBe(TEACHER_A);
    expect(JSON.stringify(data)).toContain('A 付款');
    expect(JSON.stringify(data)).not.toContain('B 秘密付款');
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
