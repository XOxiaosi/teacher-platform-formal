import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPaymentService } from '../../../src/features/payments/payment-service.js';
import type { FieldCipher } from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const TEACHER_A = 'payment-idempotency-teacher-a';
const TEACHER_B = 'payment-idempotency-teacher-b';

async function cleanup() {
  const teacherId = { in: [TEACHER_A, TEACHER_B] };
  await prisma.changeLog.deleteMany({ where: { teacherId } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId } });
  await prisma.payment.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
}

async function createStudent(teacherId: string, name: string) {
  return prisma.student.create({ data: { teacherId, name, grade: '测试年级' } });
}

function input(studentId: string, overrides: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    clientRequestId: 'payment-idempotency-request-0001',
    studentId,
    amount: 1200,
    lessonCount: 12,
    paidAt: new Date('2026-09-22T08:30:00.000Z'),
    note: '九月续费',
    ...overrides,
  };
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('payment create idempotency', () => {
  it('拒绝缺失或空请求键、非有限金额、非整数课时和无效日期，且不产生缴费或流水', async () => {
    const student = await createStudent(TEACHER_A, '非法请求学生');
    const service = createPaymentService(prisma);
    const results = await Promise.all([
      service.createPayment(input(student.id, { clientRequestId: undefined }) as never),
      service.createPayment(input(student.id, { clientRequestId: '   ' })),
      service.createPayment(input(student.id, { clientRequestId: 'invalid-amount-0001', amount: Number.NaN })),
      service.createPayment(input(student.id, { clientRequestId: 'invalid-lessons-0001', lessonCount: 1.5 })),
      service.createPayment(input(student.id, { clientRequestId: 'invalid-paid-at-0001', paidAt: new Date('invalid') })),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ field: 'clientRequestId' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ field: 'clientRequestId' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ field: 'amount' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ field: 'lessonCount' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ field: 'paidAt' }) }),
    ]);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('字段加密异常固定泛化且 Payment、购课流水和审计共同回滚', async () => {
    const student = await createStudent(TEACHER_A, '原子回滚学生');
    const secret = 'attacker-controlled encryption detail';
    const cipher = {
      encrypt() { throw new Error(`SAFETY_BLOCK: ${secret}`); },
    } as unknown as FieldCipher;
    const service = createPaymentService({ getClient: async () => prisma, cipher });

    const result = await service.createPayment(input(student.id, {
      clientRequestId: 'payment-encryption-failure-0001',
      note: '不应落库',
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '创建缴费记录失败' },
    });
    if (!result.ok) expect(result.error.message).not.toContain(secret);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('Payment 已插入后购课流水失败时整笔事务回滚且不泄露底层异常', async () => {
    const student = await createStudent(TEACHER_A, '流水回滚学生');
    const secret = 'ledger-extension-secret';
    const executed: string[] = [];
    const faultingClient = prisma.$extends({
      query: {
        payment: {
          async create({ args, query }) {
            const payment = await query(args);
            executed.push('payment');
            return payment;
          },
        },
        lessonLedgerEntry: {
          async create({ args, query }) {
            await query(args);
            executed.push('ledger');
            throw new Error(secret);
          },
        },
      },
    }) as unknown as PrismaClient;
    const service = createPaymentService(faultingClient);

    const result = await service.createPayment(input(student.id, {
      clientRequestId: 'payment-ledger-failure-0001',
    }));

    expect(executed).toEqual(['payment', 'ledger']);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '购课流水写入失败' },
    });
    if (!result.ok) expect(result.error.message).not.toContain(secret);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('Payment、购课流水和审计均已插入后审计异常仍整笔回滚', async () => {
    const student = await createStudent(TEACHER_A, '审计回滚学生');
    const secret = 'audit-extension-secret';
    const executed: string[] = [];
    const faultingClient = prisma.$extends({
      query: {
        payment: {
          async create({ args, query }) {
            const payment = await query(args);
            executed.push('payment');
            return payment;
          },
        },
        lessonLedgerEntry: {
          async create({ args, query }) {
            const entry = await query(args);
            executed.push('ledger');
            return entry;
          },
        },
        changeLog: {
          async create({ args, query }) {
            await query(args);
            executed.push('audit');
            throw new Error(secret);
          },
        },
      },
    }) as unknown as PrismaClient;
    const service = createPaymentService(faultingClient);

    const result = await service.createPayment(input(student.id, {
      clientRequestId: 'payment-audit-failure-0001',
    }));

    expect(executed).toEqual(['payment', 'ledger', 'audit']);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '课时账本审计写入失败' },
    });
    if (!result.ok) expect(result.error.message).not.toContain(secret);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('同教师同键同载荷重放同一 Payment，重新创建 PrismaClient 与服务后仍可重放', async () => {
    const student = await createStudent(TEACHER_A, '重放学生');
    const firstService = createPaymentService(prisma);
    const first = await firstService.createPayment(input(student.id));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rebuiltPrisma = new PrismaClient();
    try {
      const replay = await createPaymentService(rebuiltPrisma).createPayment(input(student.id));
      expect(replay).toMatchObject({ ok: true, value: { id: first.value.id } });
    } finally {
      await rebuiltPrisma.$disconnect();
    }
    expect(await prisma.payment.count({
      where: { teacherId: TEACHER_A, clientRequestId: 'payment-idempotency-request-0001' },
    })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({
      where: { teacherId: TEACHER_A, entryType: 'purchase', paymentId: first.value.id },
    })).toBe(1);
  });

  it('关联 purchase 流水损坏或缺失时重放固定失败且不补写', async () => {
    const student = await createStudent(TEACHER_A, '重放完整性学生');
    const service = createPaymentService(prisma);
    const original = input(student.id, { clientRequestId: 'payment-replay-integrity-0001' });
    const first = await service.createPayment(original);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const ledger = await prisma.lessonLedgerEntry.findUniqueOrThrow({ where: { paymentId: first.value.id } });

    await prisma.lessonLedgerEntry.update({
      where: { id: ledger.id },
      data: { lessonDelta: ledger.lessonDelta + 1 },
    });
    await expect(service.createPayment(original)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '缴费重放记录不完整' },
    });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A } })).toBe(1);

    await prisma.lessonLedgerEntry.delete({ where: { id: ledger.id } });
    await expect(service.createPayment(original)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '缴费重放记录不完整' },
    });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('相同请求键按教师隔离，且不能借用其他教师的学生', async () => {
    const [studentA, studentB] = await Promise.all([
      createStudent(TEACHER_A, '教师甲学生'),
      createStudent(TEACHER_B, '教师乙学生'),
    ]);
    const service = createPaymentService(prisma);

    const own = await service.createPayment(input(studentA.id));
    const otherTeacher = await service.createPayment({
      ...input(studentB.id, { teacherId: TEACHER_B }),
    });
    const crossTeacherStudent = await service.createPayment(input(studentB.id, {
      clientRequestId: 'payment-idempotency-cross-student-0001',
    }));

    expect(own.ok).toBe(true);
    expect(otherTeacher.ok).toBe(true);
    expect(crossTeacherStudent).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await prisma.payment.count({ where: { clientRequestId: 'payment-idempotency-request-0001' } })).toBe(2);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({ where: { entryType: 'purchase' } })).toBe(2);
  });

  it('同键的金额、学生、课时、日期或备注任一变更都被拒绝且不重复写入', async () => {
    const [student, replacementStudent] = await Promise.all([
      createStudent(TEACHER_A, '原学生'),
      createStudent(TEACHER_A, '替换学生'),
    ]);
    const service = createPaymentService(prisma);
    const original = input(student.id);
    const created = await service.createPayment(original);
    expect(created.ok).toBe(true);

    const variants = [
      { amount: 1300 },
      { studentId: replacementStudent.id },
      { lessonCount: 13 },
      { paidAt: new Date('2026-09-23T08:30:00.000Z') },
      { note: '变更备注' },
    ];
    for (const changes of variants) {
      await expect(service.createPayment({ ...original, ...changes })).resolves.toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR', field: 'clientRequestId' },
      });
    }
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_A, entryType: 'purchase' } })).toBe(1);
  });

  it('同键并发创建只保存一条 Payment，P2002 获得已提交记录后重放', async () => {
    const student = await createStudent(TEACHER_A, '并发学生');
    const service = createPaymentService(prisma);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.createPayment(input(student.id))));

    expect(results.every((result) => result.ok)).toBe(true);
    const ids = results.flatMap((result) => result.ok ? [result.value.id] : []);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.payment.count({
      where: { teacherId: TEACHER_A, clientRequestId: 'payment-idempotency-request-0001' },
    })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({
      where: { teacherId: TEACHER_A, entryType: 'purchase' },
    })).toBe(1);
  });

  it('同键不同载荷并发竞争时只接受先提交的一个载荷，另一个载荷全部被拒绝', async () => {
    const student = await createStudent(TEACHER_A, '竞争学生');
    const service = createPaymentService(prisma);
    const original = input(student.id);
    const changed = { ...original, note: '竞争中的不同备注' };
    const [originalResults, changedResults] = await Promise.all([
      Promise.all(Array.from({ length: 4 }, () => service.createPayment(original))),
      Promise.all(Array.from({ length: 4 }, () => service.createPayment(changed))),
    ]);

    const originalSuccesses = originalResults.filter((result) => result.ok);
    const changedSuccesses = changedResults.filter((result) => result.ok);
    expect(originalSuccesses.length === 0 || changedSuccesses.length === 0).toBe(true);
    expect(originalSuccesses.length + changedSuccesses.length).toBe(4);
    expect([...originalResults, ...changedResults].every((result) => result.ok || (
      result.error.code === 'VALIDATION_ERROR' && result.error.field === 'clientRequestId'
    ))).toBe(true);
    expect(await prisma.payment.count({
      where: { teacherId: TEACHER_A, clientRequestId: 'payment-idempotency-request-0001' },
    })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({
      where: { teacherId: TEACHER_A, entryType: 'purchase' },
    })).toBe(1);
  });
});
