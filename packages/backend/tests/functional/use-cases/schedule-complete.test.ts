import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createScheduleCompleteUseCase } from '../../../src/app/use-cases/schedule-complete/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-schedule-complete';
const OTHER_TEACHER_ID = 'test-teacher-schedule-complete-other';

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createStudent(teacherId = TEACHER_ID) {
  return prisma.student.create({ data: { teacherId, name: '张三', grade: '高三' } });
}

async function createSchedule(studentId: string | null, status = 'planned', teacherId = TEACHER_ID) {
  return prisma.schedule.create({
    data: {
      teacherId,
      studentId,
      type: 'lesson',
      title: '张三物理课',
      scheduledStartTs: new Date('2025-03-20T14:00:00'),
      scheduledEndTs: new Date('2025-03-20T15:30:00'),
      status,
    },
  });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('scheduleCompleteUseCase.completeSchedule', () => {
  it('将日程标记 completed 并创建 attended 课次', async () => {
    const student = await createStudent();
    const schedule = await createSchedule(student.id);
    const useCase = createScheduleCompleteUseCase(prisma);

    const result = await useCase.completeSchedule({ teacherId: TEACHER_ID, scheduleId: schedule.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schedule.status).toBe('completed');
    expect(result.value.lesson.status).toBe('attended');
    expect(result.value.lesson.scheduleId).toBe(schedule.id);

    const lessonCount = await prisma.lesson.count({ where: { scheduleId: schedule.id } });
    expect(lessonCount).toBe(1);
  });

  it('课次创建失败时回滚日程状态', async () => {
    const schedule = await createSchedule(null);
    const useCase = createScheduleCompleteUseCase(prisma);

    const result = await useCase.completeSchedule({ teacherId: TEACHER_ID, scheduleId: schedule.id });

    expect(result.ok).toBe(false);
    const persisted = await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(persisted.status).toBe('planned');
    const lessonCount = await prisma.lesson.count({ where: { scheduleId: schedule.id } });
    expect(lessonCount).toBe(0);
  });

  it('非法状态转换时返回 VALIDATION_ERROR 且不创建课次', async () => {
    const student = await createStudent();
    const schedule = await createSchedule(student.id, 'cancelled');
    const useCase = createScheduleCompleteUseCase(prisma);

    const result = await useCase.completeSchedule({ teacherId: TEACHER_ID, scheduleId: schedule.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    const lessonCount = await prisma.lesson.count({ where: { scheduleId: schedule.id } });
    expect(lessonCount).toBe(0);
  });

  it('拒绝其他 teacher 完成日程且不修改数据库', async () => {
    const student = await createStudent(TEACHER_ID);
    const schedule = await createSchedule(student.id, 'planned', TEACHER_ID);
    const useCase = createScheduleCompleteUseCase(prisma);

    const result = await useCase.completeSchedule({
      teacherId: OTHER_TEACHER_ID,
      scheduleId: schedule.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    const persisted = await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(persisted.status).toBe('planned');
    expect(await prisma.lesson.count({ where: { scheduleId: schedule.id } })).toBe(0);
  });
});
