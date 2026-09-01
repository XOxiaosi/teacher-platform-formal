import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentProfileUseCase } from '../../../src/app/use-cases/student-profile/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-student-profile';

async function cleanup() {
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('createStudentProfileUseCase', () => {
  it('组装学生档案汇总视图', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '张三', grade: '高三' },
    });
    const schedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        type: 'lesson',
        title: '张三物理课',
        scheduledStartTs: new Date('2025-03-20T14:00:00'),
        scheduledEndTs: new Date('2025-03-20T15:30:00'),
      },
    });
    await prisma.lesson.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        scheduleId: schedule.id,
        dateTs: new Date('2025-03-20'),
        status: 'attended',
        progress: '力学',
      },
    });
    await prisma.payment.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        amount: 3000,
        lessonCount: 20,
        paidAtTs: new Date('2025-03-01'),
      },
    });

    const useCase = createStudentProfileUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.student.name).toBe('张三');
    expect(result.value.recentSchedules.length).toBe(1);
    expect(result.value.lessonHistory.length).toBe(1);
    expect(result.value.lessonBalance.purchased).toBe(20);
    expect(result.value.lessonBalance.attended).toBe(1);
    expect(result.value.lessonBalance.remaining).toBe(19);
  });

  it('学生不存在返回 NOT_FOUND', async () => {
    const useCase = createStudentProfileUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID, studentId: 'missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('不允许读取其他老师学生', async () => {
    const student = await prisma.student.create({
      data: { teacherId: 'other-teacher-profile', name: '李四', grade: '高二' },
    });
    const useCase = createStudentProfileUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID, studentId: student.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');

    await prisma.student.delete({ where: { id: student.id } });
  });
});
