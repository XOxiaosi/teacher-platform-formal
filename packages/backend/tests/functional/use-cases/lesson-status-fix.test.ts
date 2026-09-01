import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createLessonStatusFixUseCase } from '../../../src/app/use-cases/lesson-status-fix/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-lesson-status-fix';

async function cleanup() {
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent() {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name: '张三', grade: '高三' } });
}

async function createLesson(studentId: string, date: Date, status: string) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId,
      type: 'lesson',
      title: '张三物理课',
      scheduledStartTs: date,
      scheduledEndTs: new Date(date.getTime() + 90 * 60 * 1000),
      status: 'completed',
    },
  });
  return prisma.lesson.create({ data: { teacherId: TEACHER_ID, studentId, scheduleId: schedule.id, dateTs: date, status } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('lessonStatusFixUseCase.fixLessonStatus', () => {
  it('attended -> absent 后重算余额，已上课时减少', async () => {
    const student = await createStudent();
    const lesson = await createLesson(student.id, new Date('2025-03-20T10:00:00'), 'attended');
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAtTs: new Date('2025-03-01') },
    });
    const useCase = createLessonStatusFixUseCase(prisma);

    const result = await useCase.fixLessonStatus({ lessonId: lesson.id, targetStatus: 'absent' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lesson.status).toBe('absent');
    expect(result.value.balance.purchased).toBe(20);
    expect(result.value.balance.attended).toBe(0);
    expect(result.value.balance.remaining).toBe(20);
  });

  it('absent -> attended 后重算余额，已上课时增加', async () => {
    const student = await createStudent();
    const lesson = await createLesson(student.id, new Date('2025-03-20T10:00:00'), 'absent');
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAtTs: new Date('2025-03-01') },
    });
    const useCase = createLessonStatusFixUseCase(prisma);

    const result = await useCase.fixLessonStatus({ lessonId: lesson.id, targetStatus: 'attended' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lesson.status).toBe('attended');
    expect(result.value.balance.purchased).toBe(20);
    expect(result.value.balance.attended).toBe(1);
    expect(result.value.balance.remaining).toBe(19);
  });

  it('非法状态转换时返回 VALIDATION_ERROR 且不重算余额', async () => {
    const student = await createStudent();
    const lesson = await createLesson(student.id, new Date('2025-03-20T10:00:00'), 'attended');
    const useCase = createLessonStatusFixUseCase(prisma);

    const result = await useCase.fixLessonStatus({ lessonId: lesson.id, targetStatus: 'pending' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
