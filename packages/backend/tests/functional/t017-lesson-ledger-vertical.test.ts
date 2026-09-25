import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPaymentService, createLessonLedgerService } from '../../src/features/payments/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createScheduleCompleteUseCase } from '../../src/app/use-cases/schedule-complete/index.js';
import { createLessonStatusFixUseCase } from '../../src/app/use-cases/lesson-status-fix/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEACHER_A = 't017-ledger-a';
const TEACHER_B = 't017-ledger-b';

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lessonStatusCorrectionConfirmation.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lessonLedgerAdjustmentConfirmation.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

async function student(teacherId = TEACHER_A, name = '学生') {
  return prisma.student.create({ data: { teacherId, name, grade: 'G1' } });
}

function ledger() {
  return createLessonLedgerService({ getClient: async () => prisma, cipher });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('T-017 lesson ledger vertical', () => {
  it('购买课时写入不可变 purchase 流水，余额从流水派生且不泄露跨教师学生', async () => {
    const a = await student();
    const payment = await createPaymentService({ getClient: async () => prisma, cipher }).createPayment({
      teacherId: TEACHER_A, clientRequestId: 't017-purchase-0001', studentId: a.id, amount: 800, lessonCount: 8, paidAt: new Date('2026-09-02T01:00:00.000Z'),
    });
    expect(payment).toMatchObject({ ok: true });
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A, entryType: 'purchase', paymentId: payment.ok ? payment.value.id : '' } })).toBe(1);
    expect(await ledger().calculateBalance({ teacherId: TEACHER_A, studentId: a.id })).toMatchObject({ ok: true, value: { purchased: 8, attended: 0, adjustments: 0, remaining: 8 } });

    const b = await student(TEACHER_B, 'B');
    const cross = await ledger().calculateBalance({ teacherId: TEACHER_A, studentId: b.id });
    expect(cross).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await expect(ledger().listEntries({ teacherId: TEACHER_A, studentId: b.id })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await expect(ledger().listEntries({ teacherId: TEACHER_A, studentId: 'missing-student' })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await expect(ledger().listEntries({ teacherId: TEACHER_A })).resolves.toMatchObject({
      ok: true,
      value: [{ studentId: a.id, entryType: 'purchase' }],
    });
  });

  it('退款、赠课和手动调整须两步确认：原因加密、重放安全且不同载荷冲突', async () => {
    const a = await student();
    const input = { teacherId: TEACHER_A, studentId: a.id, entryType: 'gift' as const, lessonDelta: 2, reason: '补偿上周停课', clientRequestId: 't017-gift-0001' };
    const prepared = await ledger().prepareAdjustment(input);
    const replay = await ledger().prepareAdjustment(input);
    const conflict = await ledger().prepareAdjustment({ ...input, lessonDelta: 3 });
    expect(prepared).toMatchObject({ ok: true, value: {
      confirmation: { status: 'pending', reason: '补偿上周停课' },
      balanceBefore: { adjustments: 0, remaining: 0 },
      balanceAfter: { adjustments: 2, remaining: 2 },
    } });
    expect(replay).toMatchObject({ ok: true, value: { confirmation: { id: prepared.ok ? prepared.value.confirmation.id : '' } } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const stored = await prisma.lessonLedgerAdjustmentConfirmation.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(stored.reasonCiphertext).not.toContain('补偿上周停课');

    const first = await ledger().confirmAdjustment({ teacherId: TEACHER_A, confirmationId: stored.id });
    const second = await ledger().confirmAdjustment({ teacherId: TEACHER_A, confirmationId: stored.id });
    expect(first).toMatchObject({ ok: true, value: {
      confirmation: { status: 'confirmed', entry: { entryType: 'gift', lessonDelta: 2 } },
      balance: { adjustments: 2, remaining: 2 },
    } });
    expect(second).toMatchObject({ ok: true, value: { confirmation: { status: 'confirmed' }, balance: { remaining: 2 } } });
    expect(await prisma.lessonLedgerEntry.count({ where: { adjustmentConfirmationId: stored.id } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A, targetType: 'LessonLedgerEntry' } })).toBe(1);
  });

  it('相同调整请求并发只保留同一待确认记录，不同载荷仍冲突', async () => {
    const a = await student();
    const input = { teacherId: TEACHER_A, studentId: a.id, entryType: 'gift' as const, lessonDelta: 2, reason: '并发补偿', clientRequestId: 't017-adjustment-race-0001' };
    const results = await Promise.all(Array.from({ length: 8 }, () => ledger().prepareAdjustment(input)));
    expect(results.every((result) => result.ok)).toBe(true);
    const ids = results.flatMap((result) => result.ok ? [result.value.confirmation.id] : []);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: TEACHER_A, clientRequestId: input.clientRequestId } })).toBe(1);
    await expect(ledger().prepareAdjustment({ ...input, reason: '篡改载荷' })).resolves.toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });

  it('普通完课在 B02 未决时不自动扣课或写快照；缺席不扣', async () => {
    const [a, b] = await Promise.all([student(TEACHER_A, '甲'), student(TEACHER_A, '乙')]);
    const payments = createPaymentService({ getClient: async () => prisma, cipher });
    await payments.createPayment({ teacherId: TEACHER_A, clientRequestId: 't017-complete-purchase-0001', studentId: a.id, amount: 400, lessonCount: 4, paidAt: new Date('2026-09-02T01:00:00.000Z') });
    const schedules = createScheduleService({ getClient: async () => prisma, cipher });
    const scheduled = await schedules.createSchedule({
      teacherId: TEACHER_A, clientRequestId: 't017-group-complete-0001', type: 'lesson', participantIds: [a.id, b.id], classFormat: 'small_group', location: '工作室 A',
      scheduledStart: new Date('2026-10-01T01:00:00.000Z'), scheduledEnd: new Date('2026-10-01T02:00:00.000Z'),
    });
    expect(scheduled.ok).toBe(true); if (!scheduled.ok) return;
    const complete = createScheduleCompleteUseCase({ getClient: async () => prisma, cipher });
    await expect(complete.completeSchedule({ teacherId: TEACHER_A, scheduleId: scheduled.value.schedule.id })).resolves.toMatchObject({ ok: true });
    await expect(complete.completeSchedule({ teacherId: TEACHER_A, scheduleId: scheduled.value.schedule.id })).resolves.toMatchObject({ ok: true });
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A, entryType: 'attendance_deduction' } })).toBe(0);
    expect(await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    // The compatibility projection still counts an attended lesson in the
    // read-only balance. No new attendance_deduction ledger row is written.
    expect(await ledger().calculateBalance({ teacherId: TEACHER_A, studentId: a.id })).toMatchObject({ ok: true, value: { remaining: 3 } });

    const absent = await schedules.createSchedule({
      teacherId: TEACHER_A, clientRequestId: 't017-absent-0001', type: 'lesson', participantIds: [a.id], classFormat: 'one_to_one', location: '线上',
      scheduledStart: new Date('2026-10-02T01:00:00.000Z'), scheduledEnd: new Date('2026-10-02T02:00:00.000Z'),
    });
    expect(absent.ok).toBe(true); if (!absent.ok) return;
    await expect(complete.completeSchedule({ teacherId: TEACHER_A, scheduleId: absent.value.schedule.id, lessonStatus: 'absent' })).resolves.toMatchObject({ ok: true });
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A, entryType: 'attendance_deduction', lesson: { is: { scheduleId: absent.value.schedule.id } } } })).toBe(0);
  });

  it('普通完课不预扣课，缺席到完成的显式更正才写扣课流水；并发重放不重复且跨教师拒绝', async () => {
    const a = await student();
    const payments = createPaymentService({ getClient: async () => prisma, cipher });
    await payments.createPayment({ teacherId: TEACHER_A, clientRequestId: 't017-status-fix-purchase-0001', studentId: a.id, amount: 400, lessonCount: 4, paidAt: new Date('2026-09-02T01:00:00.000Z') });
    const schedules = createScheduleService({ getClient: async () => prisma, cipher });
    const scheduled = await schedules.createSchedule({
      teacherId: TEACHER_A, clientRequestId: 't017-status-fix-0001', type: 'lesson', participantIds: [a.id], classFormat: 'one_to_one', location: '工作室 A',
      scheduledStart: new Date('2026-10-03T01:00:00.000Z'), scheduledEnd: new Date('2026-10-03T02:00:00.000Z'),
    });
    expect(scheduled.ok).toBe(true); if (!scheduled.ok) return;
    const complete = createScheduleCompleteUseCase({ getClient: async () => prisma, cipher });
    const completed = await complete.completeSchedule({ teacherId: TEACHER_A, scheduleId: scheduled.value.schedule.id });
    expect(completed.ok).toBe(true); if (!completed.ok) return;

    const correction = createLessonStatusFixUseCase(prisma);
    const correctionInput = { teacherId: TEACHER_A, lessonId: completed.value.lesson.id, targetStatus: 'absent' as const, reason: '核对考勤', clientRequestId: 't017-status-fix-correction-0001' };
    const prepared = await Promise.all([
      correction.prepareLessonStatusCorrection(correctionInput),
      correction.prepareLessonStatusCorrection(correctionInput),
    ]);
    expect(prepared.every((result) => result.ok)).toBe(true);
    if (!prepared[0].ok) return;
    const concurrent = await Promise.all([
      correction.confirmLessonStatusCorrection({ teacherId: TEACHER_A, confirmationId: prepared[0].value.confirmation.id }),
      correction.confirmLessonStatusCorrection({ teacherId: TEACHER_A, confirmationId: prepared[0].value.confirmation.id }),
    ]);
    expect(concurrent.every((result) => result.ok)).toBe(true);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A, lessonId: completed.value.lesson.id, entryType: 'attendance_reversal' } })).toBe(0);
    expect(await ledger().calculateBalance({ teacherId: TEACHER_A, studentId: a.id })).toMatchObject({ ok: true, value: { remaining: 4 } });

    const restorePrepared = await correction.prepareLessonStatusCorrection({ teacherId: TEACHER_A, lessonId: completed.value.lesson.id, targetStatus: 'attended', reason: '再次核对考勤', clientRequestId: 't017-status-fix-correction-0002' });
    expect(restorePrepared.ok).toBe(true); if (!restorePrepared.ok) return;
    const restored = await correction.confirmLessonStatusCorrection({ teacherId: TEACHER_A, confirmationId: restorePrepared.value.confirmation.id });
    expect(restored).toMatchObject({ ok: true, value: { balance: { remaining: 3 } } });
    const entries = await ledger().listEntries({ teacherId: TEACHER_A, studentId: a.id });
    expect(entries).toMatchObject({ ok: true });
    if (entries.ok) {
      expect(entries.value.filter((entry) => entry.lessonId === completed.value.lesson.id).map((entry) => [entry.entryType, entry.lessonDelta])).toEqual([
        ['attendance_deduction', -1],
      ]);
    }
    await expect(correction.prepareLessonStatusCorrection({ teacherId: TEACHER_B, lessonId: completed.value.lesson.id, targetStatus: 'absent', reason: '越权更正', clientRequestId: 't017-status-fix-cross-0001' })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
