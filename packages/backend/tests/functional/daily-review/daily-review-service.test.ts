import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createDailyReviewService } from '../../../src/features/daily-review/daily-review-service.js';

const prisma = new PrismaClient();
const service = createDailyReviewService(prisma);
const TEACHER_ID = 'test-teacher-daily-review';

async function cleanup() {
  await prisma.dailyReview.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('dailyReviewService.createReview', () => {
  it('创建每日回顾记录', async () => {
    const result = await service.createReview({
      teacherId: TEACHER_ID,
      date: new Date('2025-03-20'),
      plannedCount: 5,
      actualCount: 4,
      cancelledCount: 1,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 1,
      deviations: [{ type: 'cancelled', count: 1 }],
      corrections: [{ text: '张三实际请假' }],
      tomorrowSuggestion: '明天有 3 节课，注意确认待补全项。',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plannedCount).toBe(5);
    expect(result.value.deviations).toEqual([{ type: 'cancelled', count: 1 }]);

    // dateTs/createdAtTs/updatedAtTs 均以 *Ts 列写入
    const record = await prisma.dailyReview.findUnique({
      where: { teacherId_dateTs: { teacherId: TEACHER_ID, dateTs: new Date('2025-03-20') } },
    });
    expect(record!.dateTs).toBeInstanceOf(Date);
    expect(record!.dateTs!.getTime()).toBe(new Date('2025-03-20').getTime());
    expect(record!.createdAtTs).toBeInstanceOf(Date);
    expect(record!.updatedAtTs).toBeInstanceOf(Date);
  });

  it('缺少 teacherId 返回 VALIDATION_ERROR', async () => {
    const result = await service.createReview({
      teacherId: '',
      date: new Date('2025-03-20'),
      plannedCount: 0,
      actualCount: 0,
      cancelledCount: 0,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 0,
      deviations: [],
      corrections: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    new Date(Number.NaN),
    new Date('2025-03-20T00:00:00.001Z'),
    new Date('2025-03-20T08:00:00.000Z'),
  ])('拒绝无效或非 UTC 午夜 date，且零写入', async (date) => {
    const result = await service.createReview({
      teacherId: TEACHER_ID,
      date,
      plannedCount: 0,
      actualCount: 0,
      cancelledCount: 0,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 0,
      deviations: [],
      corrections: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    await expect(prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).resolves.toBe(0);
  });
});

describe('dailyReviewService.getReview', () => {
  it('按日期查询单个回顾', async () => {
    await service.createReview({
      teacherId: TEACHER_ID,
      date: new Date('2025-03-20'),
      plannedCount: 1,
      actualCount: 1,
      cancelledCount: 0,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 0,
      deviations: [],
      corrections: [],
    });

    const result = await service.getReview({ teacherId: TEACHER_ID, date: new Date('2025-03-20') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actualCount).toBe(1);
  });

  it('不存在返回 NOT_FOUND', async () => {
    const result = await service.getReview({ teacherId: TEACHER_ID, date: new Date('2025-03-20') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('dailyReviewService.listReviews', () => {
  it('按日期倒序查询列表', async () => {
    await service.createReview({ teacherId: TEACHER_ID, date: new Date('2025-03-19'), plannedCount: 1, actualCount: 1, cancelledCount: 0, missedCount: 0, rescheduledCount: 0, pendingCount: 0, deviations: [], corrections: [] });
    await service.createReview({ teacherId: TEACHER_ID, date: new Date('2025-03-21'), plannedCount: 2, actualCount: 2, cancelledCount: 0, missedCount: 0, rescheduledCount: 0, pendingCount: 0, deviations: [], corrections: [] });

    const result = await service.listReviews({ teacherId: TEACHER_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(2);
    expect(result.value.items[0].date.toISOString()).toContain('2025-03-21');
  });
});

describe('dailyReviewService.calculateDeviation', () => {
  it('计算计划与实际偏差', () => {
    const result = service.calculateDeviation({
      plannedSchedules: [
        { id: 's1', status: 'planned' },
        { id: 's2', status: 'cancelled' },
        { id: 's3', status: 'rescheduled' },
      ],
      actualLessons: [
        { id: 'l1', status: 'attended' },
        { id: 'l2', status: 'absent' },
      ],
      memoTasks: [{ id: 'm1', status: 'pending' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plannedCount).toBe(3);
    expect(result.value.actualCount).toBe(1);
    expect(result.value.cancelledCount).toBe(1);
    expect(result.value.missedCount).toBe(1);
    expect(result.value.rescheduledCount).toBe(1);
    expect(result.value.pendingCount).toBe(1);
    expect(result.value.deviations.length).toBeGreaterThan(0);
  });
});

describe('dailyReviewService.generateTomorrowSuggestion', () => {
  it('生成结构化明日建议', () => {
    const result = service.generateTomorrowSuggestion({
      tomorrowSchedules: [{ title: '张三物理课' }, { title: '李四试卷讲评' }],
      pendingSchedules: [{ title: '王五课程', pendingFields: ['time', 'location'] }],
      lowBalanceStudents: [{ name: '赵六', remainingLessons: 2 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('明日安排：2 项');
    expect(result.value).toContain('待补全：1 项');
    expect(result.value).toContain('低课时预警：赵六');
  });

  it('空数据返回 VALIDATION_ERROR', () => {
    const result = service.generateTomorrowSuggestion({
      tomorrowSchedules: [],
      pendingSchedules: [],
      lowBalanceStudents: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
