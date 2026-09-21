import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentProfileUseCase } from '../../../src/app/use-cases/student-profile/index.js';
import { createLessonLedgerService, createPaymentService } from '../../../src/features/payments/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-student-profile';
const cipher = createFieldCipher(loadEncryptionKey().key);

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lessonLedgerAdjustmentConfirmation.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });
afterAll(async () => { await prisma.$disconnect(); });

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
    expect(result.value.lessonBalance.adjustments).toBe(0);
    expect(result.value.lessonBalance.remaining).toBe(19);
  });

  it('学生不存在返回 NOT_FOUND', async () => {
    const useCase = createStudentProfileUseCase(prisma);
    const result = await useCase.execute({ teacherId: TEACHER_ID, studentId: 'missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('档案余额读取正式账本的购课、出勤扣课与调整净值', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '账本学生', grade: '高一' },
    });
    const payment = await createPaymentService({ getClient: async () => prisma, cipher }).createPayment({
      teacherId: TEACHER_ID,
      studentId: student.id,
      amount: 1200,
      lessonCount: 8,
      paidAt: new Date('2025-03-01'),
      clientRequestId: 'student-profile-ledger-purchase-001',
    });
    expect(payment.ok).toBe(true);

    const schedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        type: 'lesson',
        title: '账本学生物理课',
        scheduledStartTs: new Date('2025-03-20T14:00:00'),
        scheduledEndTs: new Date('2025-03-20T15:30:00'),
      },
    });
    const lesson = await prisma.lesson.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        scheduleId: schedule.id,
        dateTs: new Date('2025-03-20'),
        status: 'attended',
        progress: '力学',
      },
    });
    const ledger = createLessonLedgerService({ getClient: async () => prisma, cipher });
    await expect(ledger.recordAttendanceDeduction({ teacherId: TEACHER_ID, lessonId: lesson.id }))
      .resolves.toMatchObject({ ok: true, value: { entryType: 'attendance_deduction', lessonDelta: -1 } });

    async function confirmAdjustment(entryType: 'gift' | 'refund' | 'manual_adjustment', lessonDelta: number, requestId: string) {
      const prepared = await ledger.prepareAdjustment({
        teacherId: TEACHER_ID,
        studentId: student.id,
        entryType,
        lessonDelta,
        reason: `${entryType} 测试`,
        clientRequestId: requestId,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      await expect(ledger.confirmAdjustment({ teacherId: TEACHER_ID, confirmationId: prepared.value.id }))
        .resolves.toMatchObject({ ok: true, value: { status: 'confirmed', entry: { entryType, lessonDelta } } });
    }

    await confirmAdjustment('gift', 2, 'student-profile-ledger-gift-001');
    await confirmAdjustment('refund', -1, 'student-profile-ledger-refund-001');
    await confirmAdjustment('manual_adjustment', 1, 'student-profile-ledger-manual-001');

    const result = await createStudentProfileUseCase(prisma).execute({ teacherId: TEACHER_ID, studentId: student.id });

    expect(result).toMatchObject({
      ok: true,
      value: { lessonBalance: { purchased: 8, attended: 1, adjustments: 2, remaining: 9 } },
    });
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
