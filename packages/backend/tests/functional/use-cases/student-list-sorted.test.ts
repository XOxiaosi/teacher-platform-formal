import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentListSortedUseCase } from '../../../src/app/use-cases/student-list-sorted/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-student-list-sorted';

async function cleanup() {
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent(name: string, currentStatus = 'active') {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name, grade: '高三', currentStatus } });
}

async function createLesson(studentId: string, date: Date) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId,
      type: 'lesson',
      title: '课',
      scheduledStartTs: date,
      scheduledEndTs: new Date(date.getTime() + 90 * 60 * 1000),
    },
  });
  return prisma.lesson.create({ data: { teacherId: TEACHER_ID, studentId, scheduleId: schedule.id, dateTs: date, status: 'attended' } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('createStudentListSortedUseCase', () => {
  it('按最近上课时间倒序排序，结课学生沉底', async () => {
    const oldStudent = await createStudent('旧课学生');
    const newStudent = await createStudent('新课学生');
    await createStudent('无课学生');
    const finished = await createStudent('结课学生', 'finished');

    await createLesson(oldStudent.id, new Date('2025-03-01T10:00:00'));
    await createLesson(newStudent.id, new Date('2025-03-20T10:00:00'));
    await createLesson(finished.id, new Date('2025-04-01T10:00:00'));

    const useCase = createStudentListSortedUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.student.name)).toEqual([
      '新课学生',
      '旧课学生',
      '无课学生',
      '结课学生',
    ]);
  });

  it('返回每个学生的最近上课时间', async () => {
    const student = await createStudent('张三');
    await createLesson(student.id, new Date('2025-03-01T10:00:00'));
    await createLesson(student.id, new Date('2025-03-20T10:00:00'));

    const useCase = createStudentListSortedUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0].lastLessonAt?.toISOString()).toContain('2025-03-20');
  });

  it('不返回其他老师学生', async () => {
    await createStudent('我的学生');
    await prisma.student.create({ data: { teacherId: 'other-teacher-list', name: '别人学生', grade: '高三' } });

    const useCase = createStudentListSortedUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].student.name).toBe('我的学生');
  });
});
