import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createDailyReviewInteractUseCase } from '../../../src/app/use-cases/daily-review-interact/index.js';
import type { AiClient } from '../../../src/shared/ai-client/index.js';
import type { StorageService } from '../../../src/shared/storage/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-daily-review-interact';

async function cleanup() {
  await prisma.aINote.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.dailyReview.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

function createAiClient(extractedData: Record<string, unknown>): AiClient {
  return {
    run: async ({ taskType }) => {
      if (taskType === 'intent_recognition') {
        return ok({ intent: 'review_input', confidenceScore: 0.92 });
      }
      return ok(extractedData);
    },
  };
}

const storage: StorageService = {
  save: async () => ok({ fileRef: 'audio/ref', size: 1 }),
};

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('dailyReviewInteractUseCase.interactDailyReview', () => {
  it('解析老师自然语言回复，修正课次状态，并把修正记录写回每日回顾', async () => {
    const student = await prisma.student.create({ data: { teacherId: TEACHER_ID, name: '周九', grade: '高三' } });
    const schedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        type: 'lesson',
        title: '周九物理课',
        scheduledStartTs: new Date('2025-04-10T19:00:00+08:00'),
        scheduledEndTs: new Date('2025-04-10T20:30:00+08:00'),
        status: 'completed',
      },
    });
    const lesson = await prisma.lesson.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        scheduleId: schedule.id,
        dateTs: new Date('2025-04-10T19:00:00+08:00'),
        status: 'pending',
      },
    });
    await prisma.dailyReview.create({
      data: {
        teacherId: TEACHER_ID,
        dateTs: new Date('2025-04-10T00:00:00.000Z'),
        plannedCount: 1,
        actualCount: 0,
        cancelledCount: 0,
        missedCount: 0,
        rescheduledCount: 0,
        pendingCount: 1,
        deviations: [{ type: 'pending', count: 1 }],
        corrections: [],
      },
    });
    const useCase = createDailyReviewInteractUseCase({
      prisma,
      aiClient: createAiClient({
        lessonId: lesson.id,
        targetStatus: 'attended',
        correctionNote: '周九这节课实际已上',
      }),
      storage,
    });

    const result = await useCase.interactDailyReview({
      teacherId: TEACHER_ID,
      date: new Date('2025-04-10T21:00:00+08:00'),
      text: '周九这节课实际已上',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lesson.status).toBe('attended');
    expect(result.value.review.corrections).toHaveLength(1);
    expect(result.value.review.corrections[0]).toMatchObject({
      lessonId: lesson.id,
      fromStatus: 'pending',
      toStatus: 'attended',
      note: '周九这节课实际已上',
    });

    const persistedLesson = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    expect(persistedLesson.status).toBe('attended');
    const persistedReview = await prisma.dailyReview.findUniqueOrThrow({
      where: { teacherId_dateTs: { teacherId: TEACHER_ID, dateTs: new Date('2025-04-10T00:00:00.000Z') } },
    });
    expect(persistedReview.corrections).toEqual([
      expect.objectContaining({ lessonId: lesson.id, fromStatus: 'pending', toStatus: 'attended' }),
    ]);
  });
});
