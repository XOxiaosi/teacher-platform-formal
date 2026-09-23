import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createStudentService } from '../../src/features/students/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createPaymentService } from '../../src/features/payments/index.js';
import { createScheduleCompleteUseCase } from '../../src/app/use-cases/schedule-complete/index.js';
import { createLessonStatusFixUseCase } from '../../src/app/use-cases/lesson-status-fix/index.js';
import { createBalanceCalcUseCase } from '../../src/app/use-cases/balance-calc/index.js';
import { createDailyReviewAssembleUseCase } from '../../src/app/use-cases/daily-review-assemble/index.js';
import { createEveningReviewUseCase } from '../../src/app/use-cases/evening-review/index.js';
import type { MessageAdapter } from '../../src/adapters/shared/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-e2e-core-workflow';

async function cleanup() {
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lessonStatusCorrectionConfirmation.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.pushRecord.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.dailyReview.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
}

function createPushAdapter(): MessageAdapter {
  return { send: vi.fn(async () => ok({ providerMessageId: 'e2e-evening-review-1' })) };
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('核心教师工作流端到端', () => {
  it('创建学生、日程、完成上课、修正课次、计算余额、组装每日回顾并发送晚间复盘', async () => {
    const students = createStudentService(prisma);
    const schedules = createScheduleService(prisma);
    const payments = createPaymentService(prisma);
    const scheduleComplete = createScheduleCompleteUseCase(prisma);
    const lessonStatusFix = createLessonStatusFixUseCase(prisma);
    const balanceCalc = createBalanceCalcUseCase(prisma);
    const dailyReviewAssemble = createDailyReviewAssembleUseCase({
      prisma,
      trustedClock: { now: async () => ok(new Date('2025-05-02T13:00:00.000Z')) },
    });
    const pushAdapter = createPushAdapter();
    const eveningReview = createEveningReviewUseCase({
      prisma,
      pushAdapters: { 'wechat-bot': pushAdapter },
    });

    const createdStudent = await students.createStudent({
      teacherId: TEACHER_ID,
      name: '端到端学生',
      grade: '高三',
      source: '家长转介绍',
      stageGoal: '一轮复习查漏补缺',
    });
    expect(createdStudent.ok).toBe(true);
    if (!createdStudent.ok) return;

    const createdPayment = await payments.createPayment({
      teacherId: TEACHER_ID,
      clientRequestId: 'core-teacher-payment-0001',
      studentId: createdStudent.value.id,
      amount: 3000,
      lessonCount: 10,
      paidAt: new Date('2025-05-01T10:00:00+08:00'),
      note: '端到端预付课时',
    });
    expect(createdPayment.ok).toBe(true);

    const createdSchedule = await schedules.createSchedule({
      teacherId: TEACHER_ID,
      clientRequestId: 'core-teacher-schedule-0001',
      type: 'lesson',
      participantIds: [createdStudent.value.id],
      location: '合成教室',
      classFormat: 'one_to_one',
      scheduledStart: new Date('2025-05-02T19:00:00+08:00'),
      scheduledEnd: new Date('2025-05-02T20:30:00+08:00'),
      confidence: 'high',
    });
    expect(createdSchedule.ok).toBe(true);
    if (!createdSchedule.ok) return;
    expect(createdSchedule.value.conflicts).toEqual([]);

    const completed = await scheduleComplete.completeSchedule({
      teacherId: TEACHER_ID,
      scheduleId: createdSchedule.value.schedule.id,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.schedule.status).toBe('completed');
    expect(completed.value.lesson.status).toBe('attended');
    expect(completed.value.lesson.studentId).toBe(createdStudent.value.id);

    const correctionPrepared = await lessonStatusFix.prepareLessonStatusCorrection({
      teacherId: TEACHER_ID,
      lessonId: completed.value.lesson.id,
      targetStatus: 'absent',
      reason: '端到端考勤更正',
      clientRequestId: 'core-status-fix-0001',
    });
    expect(correctionPrepared.ok).toBe(true);
    if (!correctionPrepared.ok) return;
    const corrected = await lessonStatusFix.confirmLessonStatusCorrection({ teacherId: TEACHER_ID, confirmationId: correctionPrepared.value.confirmation.id });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.lesson.status).toBe('absent');
    expect(corrected.value.balance).toEqual({ purchased: 10, attended: 0, adjustments: 0, remaining: 10 });

    const restorePrepared = await lessonStatusFix.prepareLessonStatusCorrection({
      teacherId: TEACHER_ID,
      lessonId: completed.value.lesson.id,
      targetStatus: 'attended',
      reason: '端到端考勤恢复',
      clientRequestId: 'core-status-fix-0002',
    });
    expect(restorePrepared.ok).toBe(true);
    if (!restorePrepared.ok) return;
    const restored = await lessonStatusFix.confirmLessonStatusCorrection({ teacherId: TEACHER_ID, confirmationId: restorePrepared.value.confirmation.id });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.balance).toEqual({ purchased: 10, attended: 1, adjustments: 0, remaining: 9 });

    const balance = await balanceCalc.calculateBalance({ teacherId: TEACHER_ID, studentId: createdStudent.value.id });
    expect(balance.ok).toBe(true);
    if (!balance.ok) return;
    expect(balance.value).toEqual({ purchased: 10, attended: 1, adjustments: 0, remaining: 9 });

    const review = await dailyReviewAssemble.assembleDailyReview({
      teacherId: TEACHER_ID,
      date: '2025-05-02',
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.review.plannedCount).toBe(1);
    expect(review.value.review.actualCount).toBe(1);
    expect(review.value.review.cancelledCount).toBe(0);
    expect(review.value.review.pendingCount).toBe(0);
    expect(review.value.schedules.map((schedule) => schedule.id)).toEqual([createdSchedule.value.schedule.id]);
    expect(review.value.lessons.map((lesson) => lesson.id)).toEqual([completed.value.lesson.id]);

    const pushed = await eveningReview.sendEveningReview({
      teacherId: TEACHER_ID,
      date: new Date('2025-05-02T21:30:00+08:00'),
      channel: 'wechat-bot',
    });
    expect(pushed.ok).toBe(true);
    expect(pushAdapter.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(pushAdapter.send).mock.calls[0]![0];
    expect(sentMessage.to).toBe(TEACHER_ID);
    expect(sentMessage.content).toContain('晚间复盘提醒｜2025-05-02');
    expect(sentMessage.content).toContain('计划日程：1 项');
    expect(sentMessage.content).toContain('实际上课：1 次');
    expect(sentMessage.content).toContain('19:00-20:30 （completed）');
    expect(sentMessage.content).toContain('19:00 （attended）');
    if (!pushed.ok) return;
    expect(pushed.value.pushRecord.status).toBe('sent');
    expect(pushed.value.pushRecord.channel).toBe('wechat-bot');

    const persistedPushCount = await prisma.pushRecord.count({ where: { teacherId: TEACHER_ID, type: 'evening_review' } });
    expect(persistedPushCount).toBe(1);
  });
});
