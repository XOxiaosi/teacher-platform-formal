import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createUpdatePaymentUseCase: unknown;
let importError: unknown;
try {
  const module = await import('../../src/app/use-cases/update-payment/index.js');
  createUpdatePaymentUseCase = module.createUpdatePaymentUseCase;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'payment-command-a';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const INITIAL_PAID_AT = new Date('2030-06-01T00:00:00.000Z');
const NEXT_PAID_AT = new Date('2030-06-15T08:30:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-payment production factory import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdatePaymentUseCase !== 'function') {
    throw new Error('createUpdatePaymentUseCase export is missing');
  }
  return createUpdatePaymentUseCase as (options: any) => {
    updatePayment(command: any): Promise<any>;
  };
}

function command(paymentId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    paymentId,
    expectedUpdatedAt: BASE_TOKEN.toISOString(),
    source: 'manual-web',
    changes: {
      amount: 3500.5,
      lessonCount: 24,
      paidAt: '2030-06-15T16:30:00+08:00',
      note: null,
    },
    ...patch,
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
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

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

async function cleanup() {
  const teachers = [TEACHER_A];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

async function expectUnchanged(paymentId: string) {
  const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  expect(persisted).toMatchObject({
    amount: 3000,
    lessonCount: 20,
    paidAtTs: INITIAL_PAID_AT,
    note: '首次缴费',
    updatedAtTs: BASE_TOKEN,
  });
  expect(await prisma.changeLog.count({ where: { targetId: paymentId } })).toBe(0);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('Payment edit command raw transaction', () => {
  it('导出只接收raw Prisma的production factory', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it('默认使用PostgreSQL TrustedClock，写一条准确manual-web日志并返回receipt', async () => {
    const { payment } = await createFixture();
    const lowerBound = await databaseNow();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updatePayment(command(payment.id));

    const upperBound = await databaseNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value.value;
    expect(value.updatedAt.getTime()).not.toBe(BASE_TOKEN.getTime());
    expect(value.updatedAt.getTime()).toBeGreaterThanOrEqual(lowerBound.getTime() - 1);
    expect(value.updatedAt.getTime()).toBeLessThanOrEqual(upperBound.getTime() + 1);
    expect(value).toMatchObject({
      studentId: payment.studentId,
      amount: 3500.5,
      lessonCount: 24,
      paidAt: NEXT_PAID_AT,
      note: null,
    });

    const logs = await prisma.changeLog.findMany({ where: { targetId: payment.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: result.value.changeLogId,
      teacherId: TEACHER_A,
      module: 'payments',
      action: 'update',
      targetType: 'Payment',
      targetId: payment.id,
      source: 'manual-web',
    });
    // P8 phase-3 批4：changelog before/after 整体加密落库，解密后断言
    expect(cipher.decryptJson<unknown>(logs[0].before as unknown as string)).toEqual({
      amount: 3000,
      lessonCount: 20,
      paidAt: INITIAL_PAID_AT.toISOString(),
      note: '首次缴费',
      updatedAt: BASE_TOKEN.toISOString(),
    });
    expect(cipher.decryptJson<unknown>(logs[0].after as unknown as string)).toEqual({
      amount: 3500.5,
      lessonCount: 24,
      paidAt: NEXT_PAID_AT.toISOString(),
      note: null,
      updatedAt: value.updatedAt.toISOString(),
    });
  });

  it.each(['agent-confirmed', 'wechat-confirmed', 'system'])('日志source准确透传：%s', async (source) => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });
    const patch = source === 'system'
      ? { source, expectedUpdatedAt: undefined }
      : { source };

    const result = await useCase.updatePayment(command(payment.id, patch));

    expect(result.ok).toBe(true);
    const logs = await prisma.changeLog.findMany({ where: { targetId: payment.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe(source);
  });

  it.each([
    { expectedUpdatedAt: undefined },
    { expectedUpdatedAt: '2000-01-01T00:00:00' },
    { expectedUpdatedAt: '2000-02-30T00:00:00Z' },
  ])('expected缺失或格式非法时完整命令零写：$expectedUpdatedAt', async ({ expectedUpdatedAt }) => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updatePayment(command(payment.id, { expectedUpdatedAt }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(payment.id);
  });

  it.each([
    { changes: { amount: 0 }, field: 'amount' },
    { changes: { amount: Number.POSITIVE_INFINITY }, field: 'amount' },
    { changes: { lessonCount: 1.5 }, field: 'lessonCount' },
    { changes: { paidAt: '2030-06-15T16:30:00' }, field: 'paidAt' },
    { changes: { note: undefined }, field: 'note' },
    { changes: { amount: 3000, note: '首次缴费' }, field: 'changes' },
  ])('字段校验或事实no-op时完整命令零写：$field/$changes', async ({ changes, field }) => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updatePayment(command(payment.id, { changes }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    await expectUnchanged(payment.id);
  });

  it('不存在时完整命令返回NOT_FOUND且零写', async () => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updatePayment(command('missing-payment'));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expectUnchanged(payment.id);
  });

  it('stale优先于非法数值返回VERSION_CONFLICT且零写零日志', async () => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updatePayment(command(payment.id, {
      expectedUpdatedAt: '1999-12-31T00:00:00.000Z',
      changes: { amount: 0, lessonCount: 1.5 },
    }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(payment.id);
  });

  it('TrustedClock失败时返回INTERNAL_ERROR且零Payment写零日志', async () => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => ({
        now: vi.fn().mockResolvedValue(err(internalError('数据库可信时间不可用'))),
      }),
    });

    const result = await useCase.updatePayment(command(payment.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(payment.id);
  });

  it('TrustedClock返回before同token时零Payment写零日志', async () => {
    const { payment } = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(BASE_TOKEN),
    });

    const result = await useCase.updatePayment(command(payment.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(payment.id);
  });

  it('ChangeLog失败时通过sentinel回滚已完成的Payment条件写', async () => {
    const { payment } = await createFixture();
    const recordChange = vi.fn().mockResolvedValue(err(internalError('审计写入失败')));
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
      changelogFactory: () => ({ recordChange }),
    });

    const result = await useCase.updatePayment(command(payment.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(recordChange).toHaveBeenCalledTimes(1);
    await expectUnchanged(payment.id);
  });

  it('完整命令同一expected并发恰好一胜一冲突且只留一条日志', async () => {
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
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => clock,
    });

    const results = await Promise.all([
      useCase.updatePayment(command(payment.id, { changes: { amount: 3100 } })),
      useCase.updatePayment(command(payment.id, { changes: { amount: 3200 } })),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    expect(await prisma.changeLog.count({ where: { targetId: payment.id } })).toBe(1);
    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect([3100, 3200]).toContain(persisted.amount);
    expect(persisted.studentId).toBe(payment.studentId);
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
