import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { err, validationError } from '@teacher-platform/contracts';
import { createActionTokenSigner } from '../../src/features/pending-action/index.js';
import { createConfirmableActionRegistry } from '../../src/app/confirmation/confirmable-action-registry.js';
import { createConfirmationTransactionPort } from '../../src/app/confirmation/confirmation-transaction-port.js';
import type { ConfirmableActionExecutor } from '../../src/app/confirmation/types.js';
import { createConfirmPendingActionUseCase } from '../../src/app/use-cases/confirm-pending-action/confirm-pending-action-use-case.js';
import { createCancelPendingActionUseCase } from '../../src/app/use-cases/cancel-pending-action/cancel-pending-action-use-case.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

const TEACHER_A = 'test-confirm-workflow-teacher-a';
const SECRET = 'test-confirm-workflow-secret-with-at-least-32-bytes';

let database: IsolatedPostgres;
let prisma: PrismaClient;
let sequence = 0;

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  return rows[0].now;
}

async function seedStudent(status = 'active') {
  return prisma.student.create({
    data: { teacherId: TEACHER_A, name: '确认测试学生', grade: '高一', currentStatus: status },
  });
}

async function createPending(studentId: string, input: {
  actionName?: string;
  expired?: boolean;
} = {}) {
  const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
  const now = await databaseNow();
  return prisma.pendingAction.create({
    data: {
      teacherId: TEACHER_A,
      conversationId: conversation.id,
      toolCallId: `confirm-workflow-tool-${sequence += 1}`,
      actionName: input.actionName ?? 'students.updateStatus',
      targetType: 'Student',
      targetId: studentId,
      parameters: { studentId, status: 'paused' },
      afterSummary: '学生状态更新为 paused',
      expiresAtTs: new Date(now.getTime() + (input.expired ? -1_000 : 600_000)),
    },
  });
}

function createUseCases(registryFactory?: (tx: Prisma.TransactionClient) => ReturnType<typeof createConfirmableActionRegistry>) {
  const transaction = createConfirmationTransactionPort({ rawPrisma: prisma, registryFactory });
  return {
    confirm: createConfirmPendingActionUseCase({
      actionTokenSigner: createActionTokenSigner({ secret: SECRET }),
      transaction,
    }),
    cancel: createCancelPendingActionUseCase({ transaction }),
  };
}

function tokenFor(id: string) {
  const signed = createActionTokenSigner({ secret: SECRET }).sign(id);
  if (!signed.ok) throw new Error(signed.error.message);
  return signed.value;
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
  await prisma.student.deleteMany();
});

describe('PendingAction confirmation workflow', () => {
  it('确认使用数据库参数执行、写 ChangeLog 并消费 PendingAction', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id);
    const useCases = createUseCases();

    const result = await useCases.confirm.confirm({
      teacherId: TEACHER_A,
      pendingActionId: pending.id,
      actionToken: tokenFor(pending.id),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        pendingAction: { id: pending.id, status: 'consumed' },
        result: { references: [{ type: 'Student', id: student.id }] },
      },
    });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('paused');
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(1);
  });

  it('并发确认只有一个成功、一次业务写入和一条 ChangeLog', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id);
    const useCases = createUseCases();
    const input = {
      teacherId: TEACHER_A,
      pendingActionId: pending.id,
      actionToken: tokenFor(pending.id),
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => useCases.confirm.confirm(input)));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === 'ALREADY_CONSUMED')).toHaveLength(4);
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(1);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('consumed');
  });

  it.each([
    ['path-mismatch', () => tokenFor('other-pending-id')],
    ['tampered-signature', (id: string) => {
      const token = tokenFor(id);
      const [payload, signature] = token.split('.');
      return `${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    }],
  ])('%s token 在事务前被拒绝', async (_case, makeToken) => {
    const student = await seedStudent();
    const pending = await createPending(student.id);

    const result = await createUseCases().confirm.confirm({
      teacherId: TEACHER_A,
      pendingActionId: pending.id,
      actionToken: makeToken(pending.id),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'actionToken' } });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('pending');
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
  });

  it('过期确认提交 expired 状态，再返回结构化错误', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id, { expired: true });
    const useCases = createUseCases();

    const result = await useCases.confirm.confirm({
      teacherId: TEACHER_A,
      pendingActionId: pending.id,
      actionToken: tokenFor(pending.id),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '待确认操作已过期', field: 'pendingActionId' },
    });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('expired');
  });

  it('数据库中的未知 actionName 不进入 executor 并回滚 claim', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id, { actionName: 'payments.delete' });
    const useCases = createUseCases();

    const result = await useCases.confirm.confirm({
      teacherId: TEACHER_A, pendingActionId: pending.id, actionToken: tokenFor(pending.id),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '待确认操作类型未注册' },
    });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('pending');
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('executor Result error 回滚已发生的业务写入和 executing 状态', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id);
    const failingExecutor = (tx: Prisma.TransactionClient): ConfirmableActionExecutor => ({
      async execute() {
        await tx.student.update({ where: { id: student.id }, data: { currentStatus: 'paused' } });
        await tx.changeLog.create({
          data: {
            teacherId: TEACHER_A,
            module: 'students',
            action: 'update',
            targetType: 'Student',
            targetId: student.id,
            source: 'system',
          },
        });
        return err(validationError('审计失败', 'audit'));
      },
    });
    const useCases = createUseCases((tx) => {
      const executor = failingExecutor(tx);
      return createConfirmableActionRegistry({
        'scheduling.complete': executor,
        'scheduling.cancel': executor,
        'lessons.updateStatus': executor,
        'students.updateStatus': executor,
        'students.updateProfile': executor,
        'scheduling.reschedule': executor,
        'lessons.updateRecord': executor,
        'payments.update': executor,
        'memos.update': executor,
        'feedback.updateContent': executor,
        'feedback.updateStatus': executor,
        'payments.create': executor,
        'students.records.capture': executor,
        'scheduling.create': executor,
        'memos.create': executor,
      });
    });

    const result = await useCases.confirm.confirm({
      teacherId: TEACHER_A, pendingActionId: pending.id, actionToken: tokenFor(pending.id),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '审计失败', field: 'audit' },
    });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('pending');
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('executor 抛出异常时回滚并映射稳定 INTERNAL_ERROR', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id);
    const useCases = createUseCases((tx) => {
      const executor: ConfirmableActionExecutor = {
        async execute() {
          await tx.student.update({ where: { id: student.id }, data: { currentStatus: 'paused' } });
          throw new Error('sensitive database detail');
        },
      };
      return createConfirmableActionRegistry({
        'scheduling.complete': executor,
        'scheduling.cancel': executor,
        'lessons.updateStatus': executor,
        'students.updateStatus': executor,
        'students.updateProfile': executor,
        'scheduling.reschedule': executor,
        'lessons.updateRecord': executor,
        'payments.update': executor,
        'memos.update': executor,
        'feedback.updateContent': executor,
        'feedback.updateStatus': executor,
        'payments.create': executor,
        'students.records.capture': executor,
        'scheduling.create': executor,
        'memos.create': executor,
      });
    });

    const result = await useCases.confirm.confirm({
      teacherId: TEACHER_A, pendingActionId: pending.id, actionToken: tokenFor(pending.id),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '待确认操作执行失败' },
    });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('pending');
  });

  it('取消 pending 幂等且不执行 registry', async () => {
    const student = await seedStudent();
    const pending = await createPending(student.id);
    const useCases = createUseCases();

    const first = await useCases.cancel.cancel({ teacherId: TEACHER_A, pendingActionId: pending.id });
    const second = await useCases.cancel.cancel({ teacherId: TEACHER_A, pendingActionId: pending.id });

    expect(first).toMatchObject({ ok: true, value: { pendingAction: { status: 'cancelled' } } });
    expect(second).toEqual(first);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
  });
});
