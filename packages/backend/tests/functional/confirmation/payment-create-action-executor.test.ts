import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createDatabaseConfirmableActionRegistry } from '../../../src/app/confirmation/database-confirmable-action-registry.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

// P29-W1（第二最小切片）：payments.create executor 契约（TDD 红灯先行）。
// 实现缺失时 registry.get('payments.create') 返回 INTERNAL_ERROR('待确认操作类型未注册')，
// 以下契约断言全部红灯；实现落盘后作为契约回归套件：
// - target 固定 { type: 'Student', id: studentId }，parameters 仅
//   { studentId, amount, lessonCount, paidAt, note?, expectedUpdatedAt }
// - 同一事务内重查学生归属（跨 teacher/不存在统一 NOT_FOUND）+ expectedUpdatedAt 版本 CAS
// - 成功创建 Payment（note 密文落库、paidAt 归一化到毫秒 instant）+ 恰好一条
//   source:'agent-confirmed' 显式审计（module payments / action create / targetType Payment）
// - 任一步失败零写入（不创建 Payment、不写审计）

const TEACHER_A = 'test-payment-create-executor-a';
const TEACHER_B = 'test-payment-create-executor-b';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent(teacherId = TEACHER_A, name = '缴费学生') {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

function expectZeroEffects(studentId: string) {
  return {
    async noPayment() {
      expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    },
    async noChangelog() {
      expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    },
    async studentUnchanged() {
      const row = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
      expect(row.name).toBe('缴费学生');
    },
  };
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.changeLog.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.student.deleteMany();
});

describe('P29-W1 payments.create executor', () => {
  it('成功：创建 Payment（note 密文落库、paidAt 归一化到同一毫秒 instant）+ 恰好一条 agent-confirmed 审计', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T12:05:06.123456789+08:00',
          note: '暑期课包',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({
      ok: true,
      value: { references: [{ type: 'Payment', id: expect.any(String) }] },
    });
    if (!result.ok) return;
    const paymentId = result.value.references[0].id;
    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(persisted.teacherId).toBe(TEACHER_A);
    expect(persisted.studentId).toBe(student.id);
    expect(persisted.amount).toBe(1200);
    expect(persisted.lessonCount).toBe(10);
    // offset +08:00 与 9 位小数归一化到同一毫秒 instant（旧直接执行语义保留）
    expect(persisted.paidAtTs).toEqual(new Date('2031-02-03T04:05:06.123Z'));
    // note 以密文落库，解密后为明文
    expect(persisted.note).not.toBe('暑期课包');
    expect(cipher.decrypt(persisted.note!)).toBe('暑期课包');
    expect(persisted.createdAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);

    // 恰好一条显式 agent-confirmed 审计（fixture 学生创建不经 changelog extension，不产生审计）
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER_A, targetId: paymentId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('agent-confirmed');
    expect(logs[0].action).toBe('create');
    expect(logs[0].module).toBe('payments');
    expect(logs[0].targetType).toBe('Payment');
    expect(logs[0].before).toBeNull();
    expect(logs[0].after).not.toBeNull();
  });

  it('未提供 note 时 payment.note 为 null', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 800,
          lessonCount: 5,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payment = await prisma.payment.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(payment.note).toBeNull();
  });

  it('target 与 parameters 不一致拒绝且零写入', async () => {
    const student = await createStudent();

    const cases: Array<{
      target: { type: 'Student'; id: string };
      parameters: Record<string, unknown>;
    }> = [
      // parameters.studentId 与 target.id 不一致
      {
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: 'other-student',
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      },
      // 缺 expectedUpdatedAt
      {
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
        },
      },
      // 额外键
      {
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
          confirm: true,
        },
      },
    ];

    for (const { target, parameters } of cases) {
      const result = await prisma.$transaction(async (tx) => {
        const registry = createDatabaseConfirmableActionRegistry(tx);
        const executor = registry.get('payments.create');
        if (!executor.ok) return executor;
        return executor.value.execute({ teacherId: TEACHER_A, target, parameters });
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
      const effects = expectZeroEffects(student.id);
      await effects.noPayment();
      await effects.noChangelog();
    }
  });

  it('target type 错误拒绝且零写入', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Payment', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
    const effects = expectZeroEffects(student.id);
    await effects.noPayment();
    await effects.noChangelog();
  });

  it('expectedUpdatedAt 版本 CAS 冲突拒绝且零写入', async () => {
    const student = await createStudent();
    // 模拟并发变更：学生版本 token 前进
    await prisma.student.update({
      where: { id: student.id },
      data: { updatedAtTs: new Date('2031-01-01T00:00:00.000Z') },
    });

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(), // 旧版本
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const effects = expectZeroEffects(student.id);
    await effects.noPayment();
    await effects.noChangelog();
  });

  it('跨 teacher 返回 NOT_FOUND 且零写入', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_B,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const effects = expectZeroEffects(student.id);
    await effects.noPayment();
    await effects.noChangelog();
  });

  it('学生不存在返回 NOT_FOUND 且零写入', async () => {
    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: 'missing-student' },
        parameters: {
          studentId: 'missing-student',
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: '2030-01-01T00:00:00.000Z',
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('executor 复检拒绝非法金额/课时/缴费时间且零写入', async () => {
    const student = await createStudent();
    const base = {
      studentId: student.id,
      amount: 1200,
      lessonCount: 10,
      paidAt: '2031-02-03T04:05:06Z',
      expectedUpdatedAt: student.updatedAtTs.toISOString(),
    };
    const invalidParameters = [
      { ...base, amount: 0 },
      { ...base, amount: -100 },
      { ...base, lessonCount: 0 },
      { ...base, lessonCount: 10.5 },
      { ...base, paidAt: '2031-02-03T04:05:06' },
      { ...base, paidAt: 'bad-date' },
      { ...base, note: 123 },
    ];

    for (const parameters of invalidParameters) {
      const result = await prisma.$transaction(async (tx) => {
        const registry = createDatabaseConfirmableActionRegistry(tx);
        const executor = registry.get('payments.create');
        if (!executor.ok) return executor;
        return executor.value.execute({
          teacherId: TEACHER_A,
          target: { type: 'Student', id: student.id },
          parameters,
        });
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(['parameters', 'amount', 'lessonCount', 'paidAt', 'note']).toContain(result.error.field);
      expect(await prisma.payment.count({ where: { teacherId: TEACHER_A } })).toBe(0);
      expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    }
  });
});
