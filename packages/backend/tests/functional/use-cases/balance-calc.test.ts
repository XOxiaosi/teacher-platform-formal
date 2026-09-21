import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createBalanceCalcUseCase } from '../../../src/app/use-cases/balance-calc/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-balance-calc';
const OTHER_TEACHER_ID = 'test-teacher-balance-calc-other';

async function cleanup() {
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
}

async function createStudent(teacherId = TEACHER_ID) {
  return prisma.student.create({ data: { teacherId, name: '李四', grade: '高二' } });
}

async function createLesson(studentId: string, date: Date, status: string) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId,
      type: 'lesson',
      title: '李四物理课',
      scheduledStartTs: date,
      scheduledEndTs: new Date(date.getTime() + 90 * 60 * 1000),
      status: 'completed',
    },
  });
  return prisma.lesson.create({ data: { teacherId: TEACHER_ID, studentId, scheduleId: schedule.id, dateTs: date, status } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('balanceCalcUseCase.calculateBalance', () => {
  it('按购买课时减已上课时计算余额，忽略请假和待确认课次', async () => {
    const student = await createStudent();
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAtTs: new Date('2025-03-01') },
    });
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, amount: 1200, lessonCount: 8, paidAtTs: new Date('2025-03-15') },
    });
    await createLesson(student.id, new Date('2025-03-20T10:00:00'), 'attended');
    await createLesson(student.id, new Date('2025-03-21T10:00:00'), 'attended');
    await createLesson(student.id, new Date('2025-03-22T10:00:00'), 'absent');
    await createLesson(student.id, new Date('2025-03-23T10:00:00'), 'pending');
    const useCase = createBalanceCalcUseCase(prisma);

    const result = await useCase.calculateBalance({ teacherId: TEACHER_ID, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purchased).toBe(28);
    expect(result.value.attended).toBe(2);
    expect(result.value.adjustments).toBe(0);
    expect(result.value.remaining).toBe(26);
  });

  it('没有缴费和课次时余额为 0', async () => {
    const student = await createStudent();
    const useCase = createBalanceCalcUseCase(prisma);

    const result = await useCase.calculateBalance({ teacherId: TEACHER_ID, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ purchased: 0, attended: 0, adjustments: 0, remaining: 0 });
  });

  it('学生不存在时返回 NOT_FOUND', async () => {
    const useCase = createBalanceCalcUseCase(prisma);

    const result = await useCase.calculateBalance({ teacherId: TEACHER_ID, studentId: 'nonexistent-student' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('学生不存在');
  });

  it('拒绝跨 teacher 查询学生余额', async () => {
    const otherStudent = await createStudent(OTHER_TEACHER_ID);
    await prisma.payment.create({
      data: { teacherId: OTHER_TEACHER_ID, studentId: otherStudent.id, amount: 3000, lessonCount: 20, paidAtTs: new Date('2025-03-01') },
    });
    const useCase = createBalanceCalcUseCase(prisma);

    const result = await useCase.calculateBalance({ teacherId: TEACHER_ID, studentId: otherStudent.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('学生不存在');
  });
});
