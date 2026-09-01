import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDailyReviewAssembleUseCase } from '../../../src/app/use-cases/daily-review-assemble/index.js';

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const TEACHER_ID = 'test-teacher-daily-review-assemble';
let queryCount = 0;
prisma.$on('query', () => { queryCount += 1; });

async function cleanup() {
  await prisma.dailyReview.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent(name: string) {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name, grade: '高二' } });
}

function clockAt(instant: Date) {
  return { now: vi.fn(async () => ok(instant)) };
}

beforeEach(async () => {
  await cleanup();
  queryCount = 0;
});
afterEach(async () => { await cleanup(); });

describe('dailyReviewAssembleUseCase.assembleDailyReview', () => {
  it('按严格 BusinessDate 组装当日日程、课次偏差并写入 UTC 午夜', async () => {
    const studentA = await createStudent('赵六');
    const studentB = await createStudent('孙七');
    const completedSchedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentA.id,
        type: 'lesson',
        title: '赵六物理课',
        scheduledStartTs: new Date('2025-04-08T14:00:00+08:00'),
        scheduledEndTs: new Date('2025-04-08T15:30:00+08:00'),
        status: 'completed',
      },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentB.id,
        type: 'lesson',
        title: '孙七物理课',
        scheduledStartTs: new Date('2025-04-08T19:00:00+08:00'),
        scheduledEndTs: new Date('2025-04-08T20:30:00+08:00'),
        status: 'cancelled',
        pendingFields: ['reason'],
      },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        type: 'meeting',
        title: '隔日教研会',
        scheduledStartTs: new Date('2025-04-09T09:00:00+08:00'),
        scheduledEndTs: new Date('2025-04-09T10:00:00+08:00'),
        status: 'planned',
      },
    });
    await prisma.lesson.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentA.id,
        scheduleId: completedSchedule.id,
        dateTs: new Date('2025-04-08T14:00:00+08:00'),
        status: 'attended',
      },
    });
    const trustedClock = clockAt(new Date('2035-01-01T00:00:00.000Z'));
    const useCase = createDailyReviewAssembleUseCase({ prisma, trustedClock });

    const result = await useCase.assembleDailyReview({
      teacherId: TEACHER_ID,
      date: '2025-04-08',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(trustedClock.now).not.toHaveBeenCalled();
    expect(result.value.review.date.toISOString()).toBe('2025-04-08T00:00:00.000Z');
    expect(result.value.review.plannedCount).toBe(2);
    expect(result.value.review.actualCount).toBe(1);
    expect(result.value.review.cancelledCount).toBe(1);
    expect(result.value.review.pendingCount).toBe(1);
    expect(result.value.schedules).toHaveLength(2);
    expect(result.value.lessons).toHaveLength(1);
    expect(result.value.schedules.map((schedule) => schedule.title)).not.toContain('隔日教研会');

    const persisted = await prisma.dailyReview.findUnique({
      where: { teacherId_dateTs: { teacherId: TEACHER_ID, dateTs: new Date('2025-04-08T00:00:00.000Z') } },
    });
    expect(persisted?.plannedCount).toBe(2);
    expect(persisted?.actualCount).toBe(1);
  });

  it.each(['1992-01-01', '2000-02-29', '9998-12-31']) (
    '接受支持范围端点与真实闰日 %s',
    async (date) => {
      const trustedClock = clockAt(new Date('2035-01-01T00:00:00.000Z'));
      const useCase = createDailyReviewAssembleUseCase({ prisma, trustedClock });

      const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.date.toISOString()).toBe(`${date}T00:00:00.000Z`);
      expect(trustedClock.now).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    '',
    ' 2025-04-08',
    '2025-4-08',
    '2025-04-31',
    '2100-02-29',
    '1991-12-31',
    '9999-01-01',
    '2025-04-08T00:00:00',
    '2025-04-08T00:00:00Z',
    new Date('2025-04-08T00:00:00.000Z'),
  ])('拒绝非法显式日期 %#，且在 owner 查询前退出', async (date) => {
    const trustedClock = clockAt(new Date('2035-01-01T00:00:00.000Z'));
    const useCase = createDailyReviewAssembleUseCase({ prisma, trustedClock });
    queryCount = 0;

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(trustedClock.now).not.toHaveBeenCalled();
    expect(queryCount).toBe(0);
  });

  it.each([
    ['2025-04-30T15:59:59.999Z', '2025-04-30T00:00:00.000Z'],
    ['2025-04-30T16:00:00.000Z', '2025-05-01T00:00:00.000Z'],
  ])('缺省日期按上海跨日边界投影：%s', async (instant, expectedReviewDate) => {
    const trustedClock = clockAt(new Date(instant));
    const useCase = createDailyReviewAssembleUseCase({ prisma, trustedClock });

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(trustedClock.now).toHaveBeenCalledTimes(1);
    expect(result.value.review.date.toISOString()).toBe(expectedReviewDate);
  });

  it('进程与数据库 session 时区不改变上海业务日期投影', async () => {
    const originalTimeZone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Los_Angeles'");
        const trustedClock = {
          now: async () => {
            const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
              SELECT TIMESTAMPTZ '2030-05-01 16:00:00+00' AS "now"
            `;
            return ok(rows[0].now);
          },
        };
        const useCase = createDailyReviewAssembleUseCase({
          prisma: transaction as unknown as PrismaClient,
          trustedClock,
        });

        const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.review.date.toISOString()).toBe('2030-05-02T00:00:00.000Z');
      });
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it('clock 错误原样返回，且零 owner 调用', async () => {
    const clockError = internalError('可信时间不可用');
    const trustedClock = { now: vi.fn(async () => err(clockError)) };
    const useCase = createDailyReviewAssembleUseCase({ prisma, trustedClock });
    queryCount = 0;

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID });

    expect(result).toEqual(err(clockError));
    expect(trustedClock.now).toHaveBeenCalledTimes(1);
    expect(queryCount).toBe(0);
  });

  it.each([
    new Date(Number.NaN),
    new Date('1991-12-31T15:59:59.999Z'),
    new Date('9998-12-31T16:00:00.000Z'),
  ])('clock 无效或上海投影超范围返回 INTERNAL_ERROR，且零 owner 调用', async (instant) => {
    const trustedClock = clockAt(instant);
    const useCase = createDailyReviewAssembleUseCase({ prisma, trustedClock });
    queryCount = 0;

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(trustedClock.now).toHaveBeenCalledTimes(1);
    expect(queryCount).toBe(0);
  });

  it('Schedule 来源超过 500 条时返回 INTERNAL_ERROR，且 DailyReview 零写入', async () => {
    await prisma.schedule.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        teacherId: TEACHER_ID,
        type: 'meeting',
        title: `组装溢出日程 ${index}`,
        scheduledStartTs: new Date(Date.parse('2030-05-01T16:00:00.000Z') + index),
        scheduledEndTs: new Date(Date.parse('2030-05-01T17:00:00.000Z') + index),
      })),
    });
    const useCase = createDailyReviewAssembleUseCase({
      prisma,
      trustedClock: clockAt(new Date('2030-05-02T00:00:00.000Z')),
    });

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: '2030-05-02' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    await expect(prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).resolves.toBe(0);
  });

  it('Lesson 来源超过 500 条时返回 INTERNAL_ERROR，且 DailyReview 零写入', async () => {
    const student = await createStudent('容量学生');
    const schedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        type: 'lesson',
        title: '容量课次日程',
        scheduledStartTs: new Date('2030-05-01T16:00:00.000Z'),
        scheduledEndTs: new Date('2030-05-01T17:00:00.000Z'),
      },
    });
    await prisma.lesson.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        teacherId: TEACHER_ID,
        studentId: student.id,
        scheduleId: schedule.id,
        dateTs: new Date(Date.parse('2030-05-01T16:00:00.000Z') + index),
      })),
    });
    const useCase = createDailyReviewAssembleUseCase({
      prisma,
      trustedClock: clockAt(new Date('2030-05-02T00:00:00.000Z')),
    });

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: '2030-05-02' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    await expect(prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).resolves.toBe(0);
  });
});
