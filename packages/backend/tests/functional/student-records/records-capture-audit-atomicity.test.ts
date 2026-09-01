import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createActionTokenSigner } from '../../../src/features/pending-action/index.js';
import { createConfirmPendingActionUseCase } from '../../../src/app/use-cases/confirm-pending-action/index.js';
import {
  createConfirmationTransactionPort,
  createDatabaseConfirmableActionRegistry,
} from '../../../src/app/confirmation/index.js';
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

// P29-W1（第三最小切片）：students.records.capture 确认原子性契约
// （参考 payments-create-audit-atomicity.test.ts）：
// confirm 成功时同一事务内完成学生归属复检 + 版本 CAS + StudentRecord create
// （带 sourceText 时 + StudentSourceRecord create）+ 显式 agent-confirmed ChangeLog
// + consume；审计 Err / 数据库异常 / outer 回滚时记录、审计与 claim 全部回滚，
// PendingAction 保持 pending；raw 与 extended client 总计恰好一条（无 sourceText）/
// 两条（有 sourceText）ChangeLog，不依赖旧自动审计。

const TEACHER = 'test-records-atomicity-teacher';
const SECRET = 'test-records-atomicity-secret-with-at-least-32-bytes';
const AUDIT_SECRET = 'forced audit failure detail';
const DB_SECRET = 'forced database failure detail';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent() {
  return prisma.student.create({
    data: { teacherId: TEACHER, name: '原子性记录学生', grade: '高一', source: 'test' },
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
      toolCallId: `atomic-records-call-${Math.random()}`,
      actionName: 'students.records.capture',
      targetType: 'Student',
      targetId: student.id,
      parameters: encryptJsonFieldValue(cipher, overrides.parameters ?? {
        studentId: student.id,
        category: 'learning_state',
        summary: '原子性记录摘要',
        expectedUpdatedAt: student.updatedAtTs.toISOString(),
      }) as unknown as Prisma.InputJsonValue,
      beforeSummary: encryptFieldValue(cipher, '学生当前无该记录'),
      afterSummary: encryptFieldValue(cipher, '将创建学生记录'),
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

function faultingClient(kind: 'audit' | 'db' | 'db-source', executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      studentRecord: {
        async create({ args, query }) {
          executed.push('studentRecord');
          if (kind === 'db') throw new Error(DB_SECRET);
          return query(args);
        },
      },
      studentSourceRecord: {
        async create({ args, query }) {
          executed.push('studentSourceRecord');
          if (kind === 'db-source') throw new Error(DB_SECRET);
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

async function expectRolledBack(pendingActionId: string) {
  expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
  expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
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
  await prisma.studentRecord.deleteMany();
  await prisma.studentSourceRecord.deleteMany();
  await prisma.student.deleteMany();
});

describe('P29-W1 students.records.capture 确认原子性', () => {
  it('raw client 确认成功（无 sourceText）：StudentRecord 创建 + 恰好一条 ChangeLog(source:agent-confirmed) + PendingAction consumed', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });

    const result = await confirmWithSigner(signer, pending.id, prisma);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.references).toEqual([{ type: 'StudentRecord', id: expect.any(String) }]);
    const records = await prisma.studentRecord.findMany({ where: { teacherId: TEACHER } });
    expect(records).toHaveLength(1);
    expect(records[0].studentId).toBe(student.id);
    expect(records[0].category).toBe('learning_state');
    expect(records[0].reviewStatus).toBe('candidate');
    expect(cipher.decrypt(records[0].summary)).toBe('原子性记录摘要');
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: records[0].id, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('create');
    expect(logs[0].module).toBe('student-records');
    expect(logs[0].targetType).toBe('StudentRecord');
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('consumed');
  });

  it('extended client（withChangelog，无 sourceText）总计恰好一条 ChangeLog，不依赖旧自动审计', async () => {
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
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(1);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
  });

  it('extended client（withChangelog，带 sourceText）总计恰好两条 ChangeLog：StudentRecord + StudentSourceRecord 各一条', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id, {
      parameters: {
        studentId: student.id,
        category: 'lesson_observation',
        summary: '原子性带证据记录',
        occurredAt: '2031-02-03T04:05:06.123Z',
        sourceText: '原子性原始证据',
        sourceEntityType: 'Lesson',
        sourceEntityId: 'lesson-atomic-1',
        expectedUpdatedAt: student.updatedAtTs.toISOString(),
      },
    });
    const signer = createActionTokenSigner({ secret: SECRET });
    const extended = withChangelog(prisma, createChangelogService(prisma, cipher)) as unknown as PrismaClient;

    const result = await confirmWithSigner(signer, pending.id, extended);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(2);
    const byTarget = new Map(logs.map((log) => [log.targetType, log]));
    expect(byTarget.get('StudentRecord')?.module).toBe('student-records');
    expect(byTarget.get('StudentSourceRecord')?.module).toBe('student-source-record');
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(1);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER } })).toBe(1);
  });

  it('审计 Err 回滚 StudentRecord 与 ChangeLog，PendingAction 保持 pending，不泄漏底层错误', async () => {
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
    expect(executed).toEqual(['studentRecord', 'changelog']);
    await expectRolledBack(pending.id);
  });

  it('审计 Err（带 sourceText）回滚证据 + 记录 + 审计 + claim，PendingAction 保持 pending', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id, {
      parameters: {
        studentId: student.id,
        category: 'lesson_observation',
        summary: '原子性带证据记录',
        sourceText: '原子性原始证据',
        sourceEntityType: 'Lesson',
        sourceEntityId: 'lesson-atomic-2',
        expectedUpdatedAt: student.updatedAtTs.toISOString(),
      },
    });
    const signer = createActionTokenSigner({ secret: SECRET });
    const executed: string[] = [];
    const faulting = faultingClient('audit', executed);

    const result = await confirmWithSigner(signer, pending.id, faulting);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('变更记录写入失败');
    expect([...executed].sort()).toEqual(['changelog', 'studentRecord', 'studentSourceRecord']);
    await expectRolledBack(pending.id);
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
    expect(executed).toEqual(['studentRecord']);
    await expectRolledBack(pending.id);
  });

  it('outer TransactionClient 回滚不留下孤立 StudentRecord/ChangeLog（executor 写复用 outer tx）', async () => {
    const student = await createStudent();
    await expect(prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.records.capture');
      if (!executor.ok) throw new Error('students.records.capture executor 未注册');
      const result = await executor.value.execute({
        teacherId: TEACHER,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '外层回滚记录',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
      expect(result.ok).toBe(true);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(0);
  });

  it('claim 失败（已消费）不创建 StudentRecord 且不写审计', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER } });
    const pending = await seedPendingAction(student, conversation.id);
    const signer = createActionTokenSigner({ secret: SECRET });

    const first = await confirmWithSigner(signer, pending.id, prisma);
    expect(first.ok).toBe(true);
    const second = await confirmWithSigner(signer, pending.id, prisma);

    expect(second).toMatchObject({ ok: false, error: { code: 'ALREADY_CONSUMED' } });
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(1);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(1);
  });
});
