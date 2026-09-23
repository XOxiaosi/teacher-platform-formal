import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createActionTokenSigner } from '../../../src/features/pending-action/index.js';
import { createConfirmPendingActionUseCase } from '../../../src/app/use-cases/confirm-pending-action/index.js';
import { createConfirmationTransactionPort, createDatabaseConfirmableActionRegistry } from '../../../src/app/confirmation/index.js';
import {
  createChangelogService,
  withChangelog,
} from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  encryptFieldValue,
  encryptJsonFieldValue,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

// P29-W1（第二最小切片）：payments.create 确认原子性契约（参考 feedback-status-audit-atomicity.test.ts）：
// confirm 成功时同一事务内完成学生归属复检 + 版本 CAS + Payment create + 唯一一条
// agent-confirmed ChangeLog + consume；审计 Err / 数据库异常 / outer 回滚时 Payment、ChangeLog
// 与 claim 全部回滚，PendingAction 保持 pending；raw 与 extended client 总计恰好一条 ChangeLog。

const TEACHER = 'test-payment-create-atomicity-teacher';
const SECRET = 'test-payment-create-atomicity-secret-with-at-least-32-bytes';
const AUDIT_SECRET = 'forced audit failure detail';
const DB_SECRET = 'forced database failure detail';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent() {
  return prisma.student.create({
    data: { teacherId: TEACHER, name: '原子性缴费学生', grade: '高一', source: 'test' },
  });
}

async function seedPendingAction(student: { id: string; updatedAtTs: Date }, conversationId: string, overrides: {
  status?: string;
  parameters?: Record<string, unknown>;
} = {}) {
  const now = new Date();
  return prisma.pendingAction.create({
    data: {
      teacherId: TEACHER,
      conversationId,
      toolCallId: `atomic-payment-call-${Math.random()}`,
      actionName: 'payments.create',
      targetType: 'Student',
      targetId: student.id,
      parameters: encryptJsonFieldValue(cipher, overrides.parameters ?? {
        studentId: student.id,
        amount: 1200,
        lessonCount: 10,
        paidAt: '2031-02-03T04:05:06.123Z',
        expectedUpdatedAt: student.updatedAtTs.toISOString(),
      }) as unknown as Prisma.InputJsonValue,
      beforeSummary: encryptFieldValue(cipher, '学生当前无待确认缴费'),
      afterSummary: encryptFieldValue(cipher, '将创建缴费：金额 1200 元、课时 10 节'),
      expiresAtTs: new Date(now.getTime() + 600_000),
      createdAtTs: now,
      updatedAtTs: now,
      ...(overrides.status ? { status: overrides.status as 'pending' } : {}),
    },
  });
}

function createConfirm(signer: ReturnType<typeof createActionTokenSigner>, rawPrisma: PrismaClient) {
  return createConfirmPendingActionUseCase({
    actionTokenSigner: signer,
    transaction: createConfirmationTransactionPort({ rawPrisma }),
  });
}

async function confirmWithSigner(
  signer: ReturnType<typeof createActionTokenSigner>,
  pendingActionId: string,
  rawPrisma: PrismaClient,
) {
  const token = signer.sign(pendingActionId);
  if (!token.ok) throw new Error('sign failed');
  const confirm = createConfirm(signer, rawPrisma);
  return confirm.confirm({ teacherId: TEACHER, pendingActionId, actionToken: token.value });
}

function faultingClient(kind: 'audit' | 'db', executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      payment: {
        async create({ args, query }) {
          executed.push('payment');
          if (kind === 'db') throw new Error(DB_SECRET);
          return query(args);
        },
      },
      changeLog: {
        async create({ args, query }) {
          executed.push('changelog');
          if (kind === 'audit') throw new Error(AUDIT_SECRET);
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

async function expectRolledBack(studentId: string, pendingActionId: string) {
  expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
  expect(await prisma.changeLog.count({
    where: { teacherId: TEACHER, source: 'agent-confirmed' },
  })).toBe(0);
  expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pendingActionId } })).status).toBe('pending');
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
  await prisma.pendingAction.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.student.deleteMany();
});

describe('P29-W1 payments.create 确认原子性', () => {
  it('raw client 确认成功：Payment、唯一 purchase 账本及各自审计与 PendingAction 同事务提交', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });

    const result = await confirmWithSigner(signer, pending.id, prisma);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.references).toEqual([{ type: 'Payment', id: expect.any(String) }]);
    const payments = await prisma.payment.findMany({ where: { teacherId: TEACHER } });
    expect(payments).toHaveLength(1);
    expect(payments[0].studentId).toBe(student.id);
    expect(payments[0].amount).toBe(1200);
    expect(payments[0].lessonCount).toBe(10);
    const ledgerEntries = await prisma.lessonLedgerEntry.findMany({
      where: { teacherId: TEACHER, paymentId: payments[0].id },
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
      teacherId: TEACHER,
      studentId: student.id,
      entryType: 'purchase',
      lessonDelta: 10,
      amount: 1200,
      paymentId: payments[0].id,
    });
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: payments[0].id, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('create');
    expect(logs[0].module).toBe('payments');
    expect(logs[0].targetType).toBe('Payment');
    const ledgerLogs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: ledgerEntries[0].id, source: 'system' },
    });
    expect(ledgerLogs).toHaveLength(1);
    expect(ledgerLogs[0]).toMatchObject({ module: 'payments', action: 'create', targetType: 'LessonLedgerEntry' });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('consumed');
  });

  it('extended client（withChangelog）总计恰好一条 ChangeLog，不依赖旧自动审计', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });
    const extended = withChangelog(prisma, createChangelogService(prisma, cipher)) as unknown as PrismaClient;

    const result = await confirmWithSigner(signer, pending.id, extended);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(1);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(1);
  });

  it('审计 Err 回滚 Payment 与 ChangeLog，PendingAction 保持 pending，不泄漏底层错误', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });
    const executed: string[] = [];
    const faulting = faultingClient('audit', executed);

    const result = await confirmWithSigner(signer, pending.id, faulting);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('变更记录写入失败');
    expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect(executed).toEqual(['payment', 'changelog']);
    await expectRolledBack(student.id, pending.id);
  });

  it('数据库异常回滚全部写入，PendingAction 保持 pending，错误收敛为固定 sentinel', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });
    const executed: string[] = [];
    const faulting = faultingClient('db', executed);

    const result = await confirmWithSigner(signer, pending.id, faulting);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('待确认操作执行失败');
    expect(result.error.message).not.toContain(DB_SECRET);
    expect(executed).toEqual(['payment']);
    await expectRolledBack(student.id, pending.id);
  });

  it('outer TransactionClient 回滚不留下孤立 Payment/ChangeLog（executor 写复用 outer tx）', async () => {
    const student = await createStudent();
    // ConfirmationTransactionPort 总是自开事务（不支持嵌套交互事务），故 outer 回滚
    // 属性在 executor 层验证：executor 直接使用传入的 TransactionClient 创建 Payment + 显式审计，
    // 外层事务回滚时两者一并回滚（claim 的回滚已由上面审计 Err / DB 异常用例覆盖）。
    await expect(prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('payments.create');
      if (!executor.ok) throw new Error('payments.create executor 未注册');
      const result = await executor.value.execute({
        teacherId: TEACHER,
        pendingActionId: 'pending-action-outer-rollback',
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          amount: 1200,
          lessonCount: 10,
          paidAt: '2031-02-03T04:05:06.123Z',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
      expect(result.ok).toBe(true);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(0);
  });

  it('已消费 payments.create 重放原回执且不重复创建 Payment、purchase 或审计', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });

    const first = await confirmWithSigner(signer, pending.id, prisma);
    expect(first.ok).toBe(true);
    const second = await confirmWithSigner(signer, pending.id, prisma);

    expect(second).toEqual(first);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(1);
    expect(await prisma.lessonLedgerEntry.count({
      where: { teacherId: TEACHER, entryType: 'purchase' },
    })).toBe(1);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(1);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'system', targetType: 'LessonLedgerEntry' },
    })).toBe(1);
  });
});
