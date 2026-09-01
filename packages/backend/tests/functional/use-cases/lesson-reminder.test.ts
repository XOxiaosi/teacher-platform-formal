import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createLessonReminderUseCase } from '../../../src/app/use-cases/lesson-reminder/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-lesson-reminder';

async function cleanup() {
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent() {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name: '张三', grade: '高三' } });
}

async function createLesson(date: Date, status = 'pending') {
  const student = await createStudent();
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      type: 'lesson',
      title: '张三物理课',
      scheduledStartTs: date,
      scheduledEndTs: new Date(date.getTime() + 90 * 60 * 1000),
      status: 'completed',
    },
  });
  return prisma.lesson.create({
    data: { teacherId: TEACHER_ID, studentId: student.id, scheduleId: schedule.id, dateTs: date, status },
  });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('lessonReminderUseCase.runLessonReminder', () => {
  it('将超时 pending 课次自动改为 attended', async () => {
    const overdue = await createLesson(new Date('2025-03-20T10:00:00'), 'pending');
    const useCase = createLessonReminderUseCase(prisma);

    const result = await useCase.runLessonReminder({
      teacherId: TEACHER_ID,
      now: new Date('2025-03-20T13:00:00'),
      overdueMinutes: 120,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedCount).toBe(1);
    expect(result.value.updatedLessons[0].id).toBe(overdue.id);
    expect(result.value.updatedLessons[0].status).toBe('attended');
  });

  it('未超时 pending 课次不修改', async () => {
    await createLesson(new Date('2025-03-20T12:00:00'), 'pending');
    const useCase = createLessonReminderUseCase(prisma);

    const result = await useCase.runLessonReminder({
      teacherId: TEACHER_ID,
      now: new Date('2025-03-20T13:00:00'),
      overdueMinutes: 120,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedCount).toBe(0);
  });

  it('非 pending 课次不修改', async () => {
    await createLesson(new Date('2025-03-20T10:00:00'), 'attended');
    const useCase = createLessonReminderUseCase(prisma);

    const result = await useCase.runLessonReminder({
      teacherId: TEACHER_ID,
      now: new Date('2025-03-20T13:00:00'),
      overdueMinutes: 120,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedCount).toBe(0);
  });
});
