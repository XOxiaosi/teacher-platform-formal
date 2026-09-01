import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { internalError, ok } from '@teacher-platform/contracts';
import { createPaymentService } from '../../../src/features/payments/payment-service.js';

let createPaymentEditor: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/features/payments/payment-editor.js');
  createPaymentEditor = module.createPaymentEditor;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'payment-editor-a';
const TEACHER_B = 'payment-editor-b';
const BASE_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');
const INITIAL_PAID_AT = new Date('2030-06-01T00:00:00.000Z');
const NEXT_PAID_AT = new Date('2030-06-15T08:30:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `payment editor import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createPaymentEditor !== 'function') {
    throw new Error('createPaymentEditor export is missing');
  }
  return createPaymentEditor as (options: { prisma: PrismaClient; trustedClock: any }) => {
    updatePayment(input: any): Promise<any>;
  };
}

function trustedClock(result: any = ok(NEXT_TOKEN)) {
  return { now: vi.fn().mockResolvedValue(result) };
}

async function createFixture(teacherId = TEACHER_A) {
  const student = await prisma.student.create({
    data: { teacherId, name: '张三', grade: '高一' },
  });
  const payment = await prisma.payment.create({
    data: {
      teacherId,
      studentId: student.id,
      amount: 3000,
      lessonCount: 20,
      paidAtTs: INITIAL_PAID_AT,
      note: '首次缴费',
      updatedAtTs: BASE_TOKEN,
    },
  });
  return { student, payment };
}

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('PaymentEditor owner CAS', () => {
  it('导出独立窄owner且不替换旧PaymentService', () => {
    expect(requireFactory()).toBeTypeOf('function');
    expect(createPaymentService(prisma).updatePayment).toBeTypeOf('function');
  });

  it('owned对象接受有限小数金额、正整数课时、paidAt和null note', async () => {
    const { payment } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes: {
        amount: 3500.5,
        lessonCount: 24,
        paidAt: NEXT_PAID_AT,
        note: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.before).toMatchObject({
      amount: 3000,
      lessonCount: 20,
      paidAt: INITIAL_PAID_AT,
      note: '首次缴费',
    });
    expect(result.value.after).toMatchObject({
      amount: 3500.5,
      lessonCount: 24,
      paidAt: NEXT_PAID_AT,
      note: null,
      studentId: payment.studentId,
      updatedAt: NEXT_TOKEN,
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.paidAtTs).toBeInstanceOf(Date);
    expect(persisted.paidAtTs).toBeInstanceOf(Date);
    expect(await prisma.changeLog.count({ where: { targetId: payment.id } })).toBe(0);
  });

  it('省略字段保持原值，空字符串note合法', async () => {
    const { payment } = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes: { note: '' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after).toMatchObject({
      amount: 3000,
      lessonCount: 20,
      paidAt: INITIAL_PAID_AT,
      note: '',
    });
  });

  it.each([
    { teacherId: TEACHER_B, paymentId: 'owned-id' },
    { teacherId: TEACHER_A, paymentId: 'missing-id' },
  ])('跨teacher或不存在统一NOT_FOUND且不调用clock：$teacherId/$paymentId', async ({ teacherId, paymentId }) => {
    const { payment } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updatePayment({
      teacherId,
      paymentId: paymentId === 'owned-id' ? payment.id : paymentId,
      expectedUpdatedAt: new Date('1999-01-01T00:00:00.000Z'),
      changes: { amount: 0 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).amount).toBe(3000);
  });

  it('owned stale优先于非法数值和no-op返回VERSION_CONFLICT', async () => {
    const { payment } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: new Date('2029-12-31T00:00:00.000Z'),
      changes: { amount: 0, lessonCount: 1.5, note: payment.note },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: { studentId: 'student-2' }, field: 'changes' },
    { changes: { amount: 0 }, field: 'amount' },
    { changes: { amount: -1 }, field: 'amount' },
    { changes: { amount: Number.NaN }, field: 'amount' },
    { changes: { amount: Number.POSITIVE_INFINITY }, field: 'amount' },
    { changes: { lessonCount: 0 }, field: 'lessonCount' },
    { changes: { lessonCount: -1 }, field: 'lessonCount' },
    { changes: { lessonCount: 1.5 }, field: 'lessonCount' },
    { changes: { lessonCount: Number.NaN }, field: 'lessonCount' },
    { changes: { lessonCount: Number.POSITIVE_INFINITY }, field: 'lessonCount' },
    { changes: { paidAt: new Date(Number.NaN) }, field: 'paidAt' },
    { changes: { note: undefined }, field: 'note' },
  ])('拒绝非法owner输入：$field/$changes', async ({ changes, field }) => {
    const { payment } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('事实no-op按paidAt instant比较且不推进token', async () => {
    const { payment } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes: {
        amount: payment.amount,
        lessonCount: payment.lessonCount,
        paidAt: new Date(payment.paidAtTs.getTime()),
        note: payment.note,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'changes' });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('TrustedClock失败时零业务写', async () => {
    const { payment } = await createFixture();
    const editor = requireFactory()({
      prisma,
      trustedClock: trustedClock({ ok: false, error: internalError('数据库可信时间不可用') }),
    });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes: { amount: 3500 },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))).toMatchObject({
      amount: 3000,
      updatedAtTs: BASE_TOKEN,
    });
  });

  it('TrustedClock返回before同token时零业务写', async () => {
    const { payment } = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock(ok(BASE_TOKEN)) });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes: { amount: 3500 },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).amount).toBe(3000);
  });

  it('system省略expected仍以读取到的before token执行成功CAS', async () => {
    const { payment } = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: undefined,
      changes: { note: null },
    });

    expect(result.ok).toBe(true);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).updatedAtTs).toEqual(NEXT_TOKEN);
  });

  it('条件写前对象消失时重读分类为NOT_FOUND', async () => {
    const { payment } = await createFixture();
    const clock = {
      now: vi.fn(async () => {
        await prisma.payment.delete({ where: { id: payment.id } });
        return ok(NEXT_TOKEN);
      }),
    };
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updatePayment({
      teacherId: TEACHER_A,
      paymentId: payment.id,
      expectedUpdatedAt: payment.updatedAtTs,
      changes: { amount: 3500 },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
  });

  it('同一expected并发且都已读取before时恰好一胜一冲突', async () => {
    const { payment } = await createFixture();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clock = {
      now: vi.fn(async () => {
        calls += 1;
        if (calls === 2) release();
        await gate;
        return ok(NEXT_TOKEN);
      }),
    };
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const results = await Promise.all([
      editor.updatePayment({
        teacherId: TEACHER_A,
        paymentId: payment.id,
        expectedUpdatedAt: payment.updatedAtTs,
        changes: { amount: 3100 },
      }),
      editor.updatePayment({
        teacherId: TEACHER_A,
        paymentId: payment.id,
        expectedUpdatedAt: payment.updatedAtTs,
        changes: { amount: 3200 },
      }),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect([3100, 3200]).toContain(persisted.amount);
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
