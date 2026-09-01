import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createEveningReviewUseCase } from '../../../src/app/use-cases/evening-review/index.js';
import type { MessageAdapter } from '../../../src/adapters/shared/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-evening-review';

async function cleanup() {
  await prisma.pushRecord.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent(name: string) {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name, grade: '高二' } });
}

function createPushAdapter(): MessageAdapter {
  return { send: vi.fn(async () => ok({ providerMessageId: 'evening-review-1' })) };
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('eveningReviewUseCase.sendEveningReview', () => {
  it('组装当日日程、课次偏差摘要并发送晚间复盘提醒', async () => {
    const studentA = await createStudent('李四');
    const studentB = await createStudent('王五');
    const attendedSchedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentA.id,
        type: 'lesson',
        title: '李四物理课',
        scheduledStartTs: new Date('2025-03-20T14:00:00+08:00'),
        scheduledEndTs: new Date('2025-03-20T15:30:00+08:00'),
        status: 'completed',
      },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentB.id,
        type: 'lesson',
        title: '王五物理课',
        scheduledStartTs: new Date('2025-03-20T19:00:00+08:00'),
        scheduledEndTs: new Date('2025-03-20T20:30:00+08:00'),
        status: 'cancelled',
      },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        type: 'meeting',
        title: '明日教研会',
        scheduledStartTs: new Date('2025-03-21T09:00:00+08:00'),
        scheduledEndTs: new Date('2025-03-21T10:00:00+08:00'),
        status: 'planned',
      },
    });
    await prisma.lesson.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentA.id,
        scheduleId: attendedSchedule.id,
        dateTs: new Date('2025-03-20T14:00:00+08:00'),
        status: 'attended',
      },
    });
    const pushAdapter = createPushAdapter();
    const useCase = createEveningReviewUseCase({ prisma, pushAdapters: { 'wechat-bot': pushAdapter } });

    const result = await useCase.sendEveningReview({
      teacherId: TEACHER_ID,
      date: new Date('2025-03-20T21:00:00+08:00'),
      channel: 'wechat-bot',
    });

    expect(result.ok).toBe(true);
    expect(pushAdapter.send).toHaveBeenCalledTimes(1);
    const sentContent = vi.mocked(pushAdapter.send).mock.calls[0]![0].content;
    expect(sentContent).toContain('晚间复盘提醒｜2025-03-20');
    expect(sentContent).toContain('计划日程：2 项');
    expect(sentContent).toContain('实际上课：1 次');
    expect(sentContent).toContain('取消：1 项');
    expect(sentContent).toContain('待确认：0 项');
    expect(sentContent).toContain('今日课次：1 条');
    expect(sentContent).toContain('李四物理课');
    expect(sentContent).not.toContain('明日教研会');
    if (!result.ok) return;
    expect(result.value.content).toBe(sentContent);
    expect(result.value.pushRecord.type).toBe('evening_review');
    expect(result.value.pushRecord.status).toBe('sent');
  });

  it('推送渠道不可用时透传错误', async () => {
    const useCase = createEveningReviewUseCase({ prisma, pushAdapters: {} });

    const result = await useCase.sendEveningReview({
      teacherId: TEACHER_ID,
      date: new Date('2025-03-20T21:00:00+08:00'),
      channel: 'wechat-bot',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
