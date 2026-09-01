import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createActionTokenSigner } from '../../../src/features/pending-action/index.js';
import { createConfirmPendingActionUseCase } from '../../../src/app/use-cases/confirm-pending-action/index.js';
import {
  createConfirmationTransactionPort,
  createDatabaseConfirmableActionRegistry,
} from '../../../src/app/confirmation/index.js';
import { createFeedbackService } from '../../../src/features/feedback/index.js';
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

// P29-W1 原子性契约（参考 feedback-create-audit-atomicity.test.ts）：
// confirm 成功时同一事务内完成状态更新 + 唯一一条 agent-confirmed ChangeLog + consume；
// 审计 Err / 数据库异常 / outer 回滚时状态、ChangeLog 与 claim 全部回滚，PendingAction 保持 pending；
// raw 与 extended client 总计恰好一条 ChangeLog。

const TEACHER = 'test-feedback-status-atomicity-teacher';
const SECRET = 'test-feedback-status-atomicity-secret-with-at-least-32-bytes';
const AUDIT_SECRET = 'forced audit failure detail';
const DB_SECRET = 'forced database failure detail';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createFeedback() {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER, name: '原子性学生', grade: '高一', source: 'test' },
  });
  const service = createFeedbackService({ prisma, cipher });
  const created = await service.createFeedback({
    teacherId: TEACHER,
    studentId: student.id,
    title: '原子性反馈',
    content: '内容',
    channel: 'wechat',
    parentName: '家长',
  });
  if (!created.ok) throw new Error(`fixture createFeedback failed: ${created.error.message}`);
  await prisma.parentFeedback.update({ where: { id: created.value.id }, data: { status: 'reviewed' } });
  return prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
}

async function seedPendingAction(feedback: { id: string; updatedAtTs: Date }, conversationId: string) {
  const now = new Date();
  return prisma.pendingAction.create({
    data: {
      teacherId: TEACHER,
      conversationId,
      toolCallId: 'atomic-feedback-status-call',
      actionName: 'feedback.updateStatus',
      targetType: 'ParentFeedback',
      targetId: feedback.id,
      parameters: encryptJsonFieldValue(cipher, {
        feedbackId: feedback.id,
        status: 'sent',
        expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
      }) as unknown as Prisma.InputJsonValue,
      beforeSummary: encryptFieldValue(cipher, '家长反馈当前状态：reviewed'),
      afterSummary: encryptFieldValue(cipher, '家长反馈将更新为 sent'),
      expiresAtTs: new Date(now.getTime() + 600_000),
      createdAtTs: now,
      updatedAtTs: now,
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
      parentFeedback: {
        async updateMany({ args, query }) {
          executed.push('updateMany');
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

async function expectRolledBack(feedbackId: string, pendingActionId: string) {
  expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedbackId } })).status).toBe('reviewed');
  // 只统计确认切片的显式审计（source: agent-confirmed）；fixture 的 create 审计（system）不属于本切片
  expect(await prisma.changeLog.count({
    where: { teacherId: TEACHER, targetId: feedbackId, source: 'agent-confirmed' },
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
  await prisma.parentFeedback.deleteMany();
  await prisma.student.deleteMany();
});

describe('P29-W1 feedback.updateStatus 确认原子性', () => {
  it('raw client 确认成功：状态变更 + 恰好一条 ChangeLog(source:agent-confirmed) + PendingAction consumed', async () => {
    const feedback = await createFeedback();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(feedback, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });

    const result = await confirmWithSigner(signer, pending.id, prisma);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.references).toEqual([{ type: 'ParentFeedback', id: feedback.id }]);
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('sent');
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: feedback.id, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('agent-confirmed');
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('consumed');
  });

  it('extended client（withChangelog）总计恰好一条 ChangeLog，不依赖旧自动审计', async () => {
    const feedback = await createFeedback();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(feedback, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });
    const extended = withChangelog(prisma, createChangelogService(prisma, cipher)) as unknown as PrismaClient;

    const result = await confirmWithSigner(signer, pending.id, extended);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, targetId: feedback.id, source: 'agent-confirmed' },
    })).toBe(1);
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('sent');
  });

  it('审计 Err 回滚状态与 ChangeLog，PendingAction 保持 pending，不泄漏底层错误', async () => {
    const feedback = await createFeedback();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(feedback, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });
    const executed: string[] = [];
    const faulting = faultingClient('audit', executed);

    const result = await confirmWithSigner(signer, pending.id, faulting);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('变更记录写入失败');
    expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect(executed).toEqual(['updateMany', 'changelog']);
    await expectRolledBack(feedback.id, pending.id);
  });

  it('数据库异常回滚全部写入，PendingAction 保持 pending，错误收敛为固定 sentinel', async () => {
    const feedback = await createFeedback();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(feedback, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });
    const executed: string[] = [];
    const faulting = faultingClient('db', executed);

    const result = await confirmWithSigner(signer, pending.id, faulting);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('待确认操作执行失败');
    expect(result.error.message).not.toContain(DB_SECRET);
    expect(executed).toEqual(['updateMany']);
    await expectRolledBack(feedback.id, pending.id);
  });

  it('outer TransactionClient 回滚不留下孤立状态/ChangeLog（executor 写复用 outer tx）', async () => {
    const feedback = await createFeedback();
    // ConfirmationTransactionPort 总是自开事务（不支持嵌套交互事务），故 outer 回滚
    // 属性在 executor 层验证：executor 直接使用传入的 TransactionClient 写状态+显式审计，
    // 外层事务回滚时两者一并回滚（claim 的回滚已由上面审计 Err / DB 异常用例覆盖）。
    await expect(prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) throw new Error('feedback.updateStatus executor 未注册');
      const result = await executor.value.execute({
        teacherId: TEACHER,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
      expect(result.ok).toBe(true);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, targetId: feedback.id, source: 'agent-confirmed' },
    })).toBe(0);
  });
});
