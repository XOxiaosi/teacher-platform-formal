import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createLessonService } from '../../../src/features/lessons/lesson-service.js';

const prisma = new PrismaClient();
const service = createLessonService(prisma);

const TEACHER_ID = 'test-teacher-lessons';
const OTHER_TEACHER_ID = 'test-teacher-lessons-other';

async function createTestStudent(name: string) {
  return prisma.student.create({
    data: { teacherId: TEACHER_ID, name, grade: '高三' },
  });
}

async function createTestSchedule(studentId: string) {
  return prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId,
      type: 'lesson',
      title: '测试课',
      scheduledStartTs: new Date('2025-03-15T14:00:00'),
      scheduledEndTs: new Date('2025-03-15T15:00:00'),
    },
  });
}

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('lessonService.createLesson', () => {
  it('创建课次：默认状态为 pending', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);

    const result = await service.createLesson({
      teacherId: TEACHER_ID,
      studentId: student.id,
      scheduleId: schedule.id,
      date: new Date('2025-03-15'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
    expect(result.value.studentId).toBe(student.id);
    expect(result.value.scheduleId).toBe(schedule.id);
  });

  it('创建课次带初始状态', async () => {
    const student = await createTestStudent('李四');
    const schedule = await createTestSchedule(student.id);

    const result = await service.createLesson({
      teacherId: TEACHER_ID,
      studentId: student.id,
      scheduleId: schedule.id,
      date: new Date('2025-03-15'),
      status: 'attended',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('attended');
  });
});

describe('lessonService.getLesson', () => {
  it('查询单个课次', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);
    const created = await service.createLesson({
      teacherId: TEACHER_ID,
      studentId: student.id,
      scheduleId: schedule.id,
      date: new Date('2025-03-15'),
    });
    if (!created.ok) return;

    const result = await service.getLesson(created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(created.value.id);
  });

  it('查询不存在返回 NOT_FOUND', async () => {
    const result = await service.getLesson('nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('lessonService.listLessons', () => {
  it('按 teacherId 查询，按日期倒序', async () => {
    const student = await createTestStudent('张三');
    const sc1 = await prisma.schedule.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, type: 'lesson', title: 'c1', scheduledStartTs: new Date('2025-03-10'), scheduledEndTs: new Date('2025-03-10T15:00:00') },
    });
    const sc2 = await prisma.schedule.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, type: 'lesson', title: 'c2', scheduledStartTs: new Date('2025-03-20'), scheduledEndTs: new Date('2025-03-20T15:00:00') },
    });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc1.id, date: new Date('2025-03-10') });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc2.id, date: new Date('2025-03-20') });

    const result = await service.listLessons({ teacherId: TEACHER_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(2);
    expect(result.value.items[0].date.toISOString()).toContain('2025-03-20');
    expect(result.value.items[1].date.toISOString()).toContain('2025-03-10');
  });

  it('按 studentId 过滤', async () => {
    const s1 = await createTestStudent('张三');
    const s2 = await createTestStudent('李四');
    const sc1 = await createTestSchedule(s1.id);
    const sc2 = await createTestSchedule(s2.id);
    await service.createLesson({ teacherId: TEACHER_ID, studentId: s1.id, scheduleId: sc1.id, date: new Date('2025-03-15') });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: s2.id, scheduleId: sc2.id, date: new Date('2025-03-15') });

    const result = await service.listLessons({ teacherId: TEACHER_ID, studentId: s1.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].studentId).toBe(s1.id);
  });

  it('按 status 过滤', async () => {
    const student = await createTestStudent('张三');
    const sc1 = await createTestSchedule(student.id);
    const sc2 = await prisma.schedule.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, type: 'lesson', title: 'c2', scheduledStartTs: new Date('2025-03-16'), scheduledEndTs: new Date('2025-03-16T15:00:00') },
    });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc1.id, date: new Date('2025-03-15'), status: 'attended' });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc2.id, date: new Date('2025-03-16'), status: 'pending' });

    const result = await service.listLessons({ teacherId: TEACHER_ID, status: 'attended' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].status).toBe('attended');
  });
});

describe('lessonService.listLessonsInWindow', () => {
  const windowStart = new Date('2030-05-01T16:00:00.000Z');
  const windowEndExclusive = new Date('2030-05-02T16:00:00.000Z');

  async function createLessonOwnerFixture(teacherId = TEACHER_ID) {
    const student = await prisma.student.create({
      data: { teacherId, name: `窗口学生-${teacherId}`, grade: '高二' },
    });
    const schedule = await prisma.schedule.create({
      data: {
        teacherId,
        studentId: student.id,
        type: 'lesson',
        title: '窗口课次日程',
        scheduledStartTs: windowStart,
        scheduledEndTs: new Date('2030-05-01T17:00:00.000Z'),
      },
    });
    return { student, schedule };
  }

  it('按 date 半开窗口查询并隔离 teacher', async () => {
    const owned = await createLessonOwnerFixture();
    const other = await createLessonOwnerFixture(OTHER_TEACHER_ID);
    await prisma.lesson.createMany({
      data: [
        { id: 'lesson-before', teacherId: TEACHER_ID, studentId: owned.student.id, scheduleId: owned.schedule.id, dateTs: new Date('2030-05-01T15:59:59.999Z') },
        { id: 'lesson-start', teacherId: TEACHER_ID, studentId: owned.student.id, scheduleId: owned.schedule.id, dateTs: windowStart },
        { id: 'lesson-inside', teacherId: TEACHER_ID, studentId: owned.student.id, scheduleId: owned.schedule.id, dateTs: new Date('2030-05-02T15:59:59.999Z') },
        { id: 'lesson-end', teacherId: TEACHER_ID, studentId: owned.student.id, scheduleId: owned.schedule.id, dateTs: windowEndExclusive },
        { id: 'lesson-other', teacherId: OTHER_TEACHER_ID, studentId: other.student.id, scheduleId: other.schedule.id, dateTs: windowStart },
      ],
    });

    const result = await service.listLessonsInWindow({
      teacherId: TEACHER_ID,
      windowStart,
      windowEndExclusive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.id)).toEqual(['lesson-start', 'lesson-inside']);
    expect(result.value.total).toBe(2);
  });

  it.each([101, 500])('完整返回 %i 条并按 date、id 升序', async (count) => {
    const owned = await createLessonOwnerFixture();
    await prisma.lesson.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        id: `capacity-lesson-${String(count - index).padStart(3, '0')}`,
        teacherId: TEACHER_ID,
        studentId: owned.student.id,
        scheduleId: owned.schedule.id,
        dateTs: windowStart,
      })),
    });

    const result = await service.listLessonsInWindow({
      teacherId: TEACHER_ID,
      windowStart,
      windowEndExclusive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(count);
    expect(result.value.total).toBe(count);
    expect(result.value.items.map((item) => item.id)).toEqual(
      [...result.value.items.map((item) => item.id)].sort(),
    );
  });

  it('501 条返回 INTERNAL_ERROR，不静默截断', async () => {
    const owned = await createLessonOwnerFixture();
    await prisma.lesson.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        teacherId: TEACHER_ID,
        studentId: owned.student.id,
        scheduleId: owned.schedule.id,
        dateTs: new Date(windowStart.getTime() + index),
      })),
    });

    const result = await service.listLessonsInWindow({
      teacherId: TEACHER_ID,
      windowStart,
      windowEndExclusive,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it.each([
    ['', windowStart, windowEndExclusive],
    [TEACHER_ID, new Date(Number.NaN), windowEndExclusive],
    [TEACHER_ID, windowStart, new Date(Number.NaN)],
    [TEACHER_ID, windowStart, windowStart],
    [TEACHER_ID, windowEndExclusive, windowStart],
  ])('拒绝非法 teacher 或半开窗口 %#', async (teacherId, start, endExclusive) => {
    const result = await service.listLessonsInWindow({
      teacherId,
      windowStart: start,
      windowEndExclusive: endExclusive,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('lessonService.updateLesson', () => {
  it('修改课次内容', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);
    const created = await service.createLesson({
      teacherId: TEACHER_ID, studentId: student.id, scheduleId: schedule.id, date: new Date('2025-03-15'),
    });
    if (!created.ok) return;

    const result = await service.updateLesson({
      lessonId: created.value.id,
      progress: '力学第三章',
      homework: '完成练习题 1-5',
      teacherNote: '学生理解较好',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.progress).toBe('力学第三章');
    expect(result.value.homework).toBe('完成练习题 1-5');
    expect(result.value.teacherNote).toBe('学生理解较好');
  });

  it('不存在返回 NOT_FOUND', async () => {
    const result = await service.updateLesson({ lessonId: 'nonexistent', progress: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('lessonService.updateLessonStatus', () => {
  it('pending -> attended: 合法', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);
    const created = await service.createLesson({
      teacherId: TEACHER_ID, studentId: student.id, scheduleId: schedule.id, date: new Date('2025-03-15'),
    });
    if (!created.ok) return;

    const result = await service.updateLessonStatus({
      lessonId: created.value.id,
      targetStatus: 'attended',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('attended');
  });

  it('更新状态时写入 updatedAtTs', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);
    const created = await service.createLesson({
      teacherId: TEACHER_ID, studentId: student.id, scheduleId: schedule.id, date: new Date('2025-03-15'),
    });
    if (!created.ok) return;

    const result = await service.updateLessonStatus({
      lessonId: created.value.id,
      targetStatus: 'attended',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('attended');

    const record = await prisma.lesson.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(record.updatedAtTs).toBeInstanceOf(Date);
  });

  it('attended -> absent: 合法（回溯）', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);
    const created = await service.createLesson({
      teacherId: TEACHER_ID, studentId: student.id, scheduleId: schedule.id, date: new Date('2025-03-15'), status: 'attended',
    });
    if (!created.ok) return;

    const result = await service.updateLessonStatus({
      lessonId: created.value.id,
      targetStatus: 'absent',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('absent');
  });

  it('attended -> pending: 非法', async () => {
    const student = await createTestStudent('张三');
    const schedule = await createTestSchedule(student.id);
    const created = await service.createLesson({
      teacherId: TEACHER_ID, studentId: student.id, scheduleId: schedule.id, date: new Date('2025-03-15'), status: 'attended',
    });
    if (!created.ok) return;

    const result = await service.updateLessonStatus({
      lessonId: created.value.id,
      targetStatus: 'pending',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('lessonService.countByStudent', () => {
  it('统计学生已上课次数（默认 attended）', async () => {
    const student = await createTestStudent('张三');
    const sc1 = await createTestSchedule(student.id);
    const sc2 = await prisma.schedule.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, type: 'lesson', title: 'c2', scheduledStartTs: new Date('2025-03-16'), scheduledEndTs: new Date('2025-03-16T15:00:00') },
    });
    const sc3 = await prisma.schedule.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, type: 'lesson', title: 'c3', scheduledStartTs: new Date('2025-03-17'), scheduledEndTs: new Date('2025-03-17T15:00:00') },
    });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc1.id, date: new Date('2025-03-15'), status: 'attended' });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc2.id, date: new Date('2025-03-16'), status: 'attended' });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc3.id, date: new Date('2025-03-17'), status: 'absent' });

    const result = await service.countByStudent({ studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(2);
  });

  it('按指定状态统计', async () => {
    const student = await createTestStudent('张三');
    const sc1 = await createTestSchedule(student.id);
    const sc2 = await prisma.schedule.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, type: 'lesson', title: 'c2', scheduledStartTs: new Date('2025-03-16'), scheduledEndTs: new Date('2025-03-16T15:00:00') },
    });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc1.id, date: new Date('2025-03-15'), status: 'absent' });
    await service.createLesson({ teacherId: TEACHER_ID, studentId: student.id, scheduleId: sc2.id, date: new Date('2025-03-16'), status: 'attended' });

    const result = await service.countByStudent({ studentId: student.id, status: 'absent' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(1);
  });

  it('学生不存在返回 NOT_FOUND', async () => {
    const result = await service.countByStudent({ studentId: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});