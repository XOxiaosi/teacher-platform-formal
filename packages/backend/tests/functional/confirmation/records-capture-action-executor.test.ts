import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createActionTokenSigner } from '../../../src/features/pending-action/index.js';
import { createConfirmPendingActionUseCase } from '../../../src/app/use-cases/confirm-pending-action/index.js';
import {
  createConfirmationTransactionPort,
  createDatabaseConfirmableActionRegistry,
} from '../../../src/app/confirmation/index.js';
import {
  createFieldCipher,
  encryptFieldValue,
  encryptJsonFieldValue,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

// P29-W1（第三最小切片）：students.records.capture executor 契约（TDD 红灯先行）。
// 实现缺失时 registry.get('students.records.capture') 返回 INTERNAL_ERROR('待确认操作类型未注册')，
// 以下契约断言全部红灯；实现落盘后作为契约回归套件：
// - target 固定 { type: 'Student', id: studentId }，parameters 仅
//   { studentId, category, summary, occurredAt?, sourceText?, sourceEntityType?,
//     sourceEntityId?, confidence?, visibility?, importance?, expectedUpdatedAt }
// - 同一事务内重查学生归属（跨 teacher/不存在统一 NOT_FOUND）+ expectedUpdatedAt 版本 CAS
// - 成功创建 StudentRecord（summary 密文落库、reviewStatus='candidate'、可选字段透传）+
//   恰好一条 source:'agent-confirmed' 显式审计（module student-records / action create /
//   targetType StudentRecord）；带 sourceText 时同事务创建 StudentSourceRecord
//   （sourceText 密文、sourceType=agent_text、captureStatus=captured）+ 恰好两条 agent-confirmed 审计
// - 任一步失败零写入（不创建记录/证据、不写审计）

const TEACHER_A = 'test-records-executor-a';
const TEACHER_B = 'test-records-executor-b';
const SECRET = 'test-records-executor-secret-with-at-least-32-bytes';
const AUDIT_SECRET = 'forced audit failure detail';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent(teacherId = TEACHER_A, name = '记录学生') {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

function expectZeroEffects() {
  return {
    async noRecord() {
      expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    },
    async noSourceRecord() {
      expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    },
    async noChangelog() {
      expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    },
  };
}

async function seedPendingAction(student: { id: string; updatedAtTs: Date }, conversationId: string) {
  const now = new Date();
  return prisma.pendingAction.create({
    data: {
      teacherId: TEACHER_A,
      conversationId,
      toolCallId: `executor-records-call-${Math.random()}`,
      actionName: 'students.records.capture',
      targetType: 'Student',
      targetId: student.id,
      parameters: encryptJsonFieldValue(cipher, {
        studentId: student.id,
        category: 'learning_state',
        summary: '本周学习状态稳定',
        expectedUpdatedAt: student.updatedAtTs.toISOString(),
      }) as unknown as Prisma.InputJsonValue,
      beforeSummary: encryptFieldValue(cipher, '学生当前无该记录'),
      afterSummary: encryptFieldValue(cipher, '将创建学生记录'),
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
  return confirm.confirm({ teacherId: TEACHER_A, pendingActionId, actionToken: token.value });
}

function faultingClient(kind: 'audit' | 'db', executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      studentRecord: {
        async create({ args, query }) {
          executed.push('studentRecord');
          if (kind === 'db') throw new Error('forced database failure detail');
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

describe('P29-W1 students.records.capture executor', () => {
  it('成功（无 sourceText）：创建 StudentRecord（summary 密文落库、reviewStatus=candidate、可选字段透传）+ 恰好一条 agent-confirmed 审计', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.records.capture');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '本周学习状态稳定',
          occurredAt: '2031-02-03T04:05:06.123Z',
          confidence: 'high',
          visibility: 'parent_shareable',
          importance: 'important',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({
      ok: true,
      value: { references: [{ type: 'StudentRecord', id: expect.any(String) }] },
    });
    if (!result.ok) return;
    const recordId = result.value.references[0].id;
    const persisted = await prisma.studentRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(persisted.teacherId).toBe(TEACHER_A);
    expect(persisted.studentId).toBe(student.id);
    expect(persisted.category).toBe('learning_state');
    // summary 以密文落库，解密后为明文
    expect(persisted.summary).not.toBe('本周学习状态稳定');
    expect(cipher.decrypt(persisted.summary)).toBe('本周学习状态稳定');
    expect(persisted.occurredAtTs).toEqual(new Date('2031-02-03T04:05:06.123Z'));
    expect(persisted.reviewStatus).toBe('candidate');
    expect(persisted.confidence).toBe('high');
    expect(persisted.visibility).toBe('parent_shareable');
    expect(persisted.importance).toBe('important');
    expect(persisted.sourceRecordId).toBeNull();
    expect(persisted.createdAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);

    // 恰好一条显式 agent-confirmed 审计（fixture 学生创建不经 changelog extension，不产生审计）
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER_A, targetId: recordId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('agent-confirmed');
    expect(logs[0].action).toBe('create');
    expect(logs[0].module).toBe('student-records');
    expect(logs[0].targetType).toBe('StudentRecord');
    expect(logs[0].before).toBeNull();
    expect(logs[0].after).not.toBeNull();
  });

  it('成功（带 sourceText）：同事务创建 StudentSourceRecord + StudentRecord（sourceRecordId 关联）+ 恰好两条 agent-confirmed 审计', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.records.capture');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'lesson_observation',
          summary: '课堂专注度良好',
          occurredAt: '2031-02-03T04:05:06.123Z',
          sourceText: '课堂观察原始文本',
          sourceEntityType: 'Lesson',
          sourceEntityId: 'lesson-1',
          confidence: 'medium',
          visibility: 'internal_only',
          importance: 'normal',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const source = await prisma.studentSourceRecord.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(source.studentId).toBe(student.id);
    expect(source.sourceType).toBe('agent_text');
    expect(source.sourceEntityType).toBe('Lesson');
    expect(source.sourceEntityId).toBe('lesson-1');
    expect(source.rawText).not.toBe('课堂观察原始文本');
    expect(cipher.decrypt(source.rawText!)).toBe('课堂观察原始文本');
    expect(source.captureStatus).toBe('captured');
    expect(source.occurredAtTs).toEqual(new Date('2031-02-03T04:05:06.123Z'));

    const record = await prisma.studentRecord.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(record.sourceRecordId).toBe(source.id);
    expect(record.category).toBe('lesson_observation');
    expect(record.reviewStatus).toBe('candidate');
    expect(cipher.decrypt(record.summary)).toBe('课堂专注度良好');

    // 恰好两条显式 agent-confirmed 审计：一条 StudentRecord、一条 StudentSourceRecord
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER_A, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(2);
    const byTarget = new Map(logs.map((log) => [log.targetType, log]));
    expect(byTarget.get('StudentRecord')).toMatchObject({
      module: 'student-records',
      action: 'create',
      targetId: record.id,
    });
    expect(byTarget.get('StudentSourceRecord')).toMatchObject({
      module: 'student-source-record',
      action: 'create',
      targetId: source.id,
    });
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
          category: 'learning_state',
          summary: '本周学习状态稳定',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      },
      // 缺 expectedUpdatedAt
      {
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '本周学习状态稳定',
        },
      },
      // 额外键
      {
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '本周学习状态稳定',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
          confirm: true,
        },
      },
    ];

    for (const { target, parameters } of cases) {
      const result = await prisma.$transaction(async (tx) => {
        const registry = createDatabaseConfirmableActionRegistry(tx);
        const executor = registry.get('students.records.capture');
        if (!executor.ok) return executor;
        return executor.value.execute({ teacherId: TEACHER_A, target, parameters });
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
      const effects = expectZeroEffects();
      await effects.noRecord();
      await effects.noSourceRecord();
      await effects.noChangelog();
    }
  });

  it('target type 错误拒绝且零写入', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.records.capture');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Payment', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '本周学习状态稳定',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
    const effects = expectZeroEffects();
    await effects.noRecord();
    await effects.noSourceRecord();
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
      const executor = registry.get('students.records.capture');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '本周学习状态稳定',
          expectedUpdatedAt: student.updatedAtTs.toISOString(), // 旧版本
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const effects = expectZeroEffects();
    await effects.noRecord();
    await effects.noSourceRecord();
    await effects.noChangelog();
  });

  it('跨 teacher 返回 NOT_FOUND 且零写入', async () => {
    const student = await createStudent();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.records.capture');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_B,
        target: { type: 'Student', id: student.id },
        parameters: {
          studentId: student.id,
          category: 'learning_state',
          summary: '本周学习状态稳定',
          expectedUpdatedAt: student.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const effects = expectZeroEffects();
    await effects.noRecord();
    await effects.noSourceRecord();
    await effects.noChangelog();
  });

  it('学生不存在返回 NOT_FOUND 且零写入', async () => {
    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.records.capture');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: 'missing-student' },
        parameters: {
          studentId: 'missing-student',
          category: 'learning_state',
          summary: '本周学习状态稳定',
          expectedUpdatedAt: '2030-01-01T00:00:00.000Z',
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('executor 复检拒绝非法类别/置信度/可见性/重要性/时间/摘要且零写入', async () => {
    const student = await createStudent();
    const base = {
      studentId: student.id,
      category: 'learning_state',
      summary: '本周学习状态稳定',
      expectedUpdatedAt: student.updatedAtTs.toISOString(),
    };
    const invalidParameters = [
      { ...base, category: 'invalid' },
      { ...base, confidence: 'maybe' },
      { ...base, visibility: 'public' },
      { ...base, importance: 'urgent' },
      { ...base, occurredAt: '2031-02-03T04:05:06' },
      { ...base, occurredAt: 'bad-date' },
      { ...base, summary: '' },
      { ...base, summary: '   ' },
      { ...base, summary: 123 },
      { ...base, sourceText: 123 },
      { ...base, studentId: '' },
    ];

    for (const parameters of invalidParameters) {
      const result = await prisma.$transaction(async (tx) => {
        const registry = createDatabaseConfirmableActionRegistry(tx);
        const executor = registry.get('students.records.capture');
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
      expect([
        'parameters', 'studentId', 'category', 'summary', 'occurredAt',
        'confidence', 'visibility', 'importance', 'sourceText',
      ]).toContain(result.error.field);
      expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
      expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
      expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    }
  });

  it('审计失败返回 Err（变更记录写入失败）且经确认事务整体回滚：零写入、PendingAction 保持 pending、不泄漏底层错误', async () => {
    const student = await createStudent();
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
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
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('pending');
  });
});
