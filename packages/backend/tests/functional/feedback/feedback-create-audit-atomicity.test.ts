import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import {
  createChangelogService,
  withChangelog,
  type ChangelogFactory,
} from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';
import type { TrustedClock } from '../../../src/shared/trusted-clock/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const changelogQueryService = createChangelogService(prisma, cipher);
const TEACHER_ID = 'test-teacher-feedback-create-audit';
const AUDIT_SECRET = 'database audit failure detail';
const EVIDENCE_DB_SECRET = 'forced evidence database failure detail';
const PARENT_FEEDBACK_CREATE_ROLLBACK_MESSAGE = 'parent-feedback-create transaction rollback';
const CLOCK_VALUE = new Date('2032-01-02T03:04:05.678Z');

const failingChangelogFactory: ChangelogFactory = () => ({
  async recordChange() {
    return err(internalError(AUDIT_SECRET));
  },
});

function trackingChangelogFactory(onSuccess: () => void): ChangelogFactory {
  return (client) => {
    const changelog = createChangelogService(client, cipher);
    return {
      async recordChange(input) {
        const result = await changelog.recordChange(input);
        if (result.ok) onSuccess();
        return result;
      },
    };
  };
}

function faultingEvidenceClient(executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      parentFeedback: {
        async create({ args, query }) {
          const feedback = await query(args);
          executed.push('feedback');
          return feedback;
        },
      },
      feedbackEvidence: {
        async createMany() {
          executed.push('evidence');
          throw new Error(EVIDENCE_DB_SECRET);
        },
      },
    },
  }) as unknown as PrismaClient;
}

async function captureRejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected transaction to reject');
}

async function expectCreateRowsRolledBack() {
  expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  expect(await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  expect(await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
}

function fixedClock(): TrustedClock {
  return { now: async () => ok(CLOCK_VALUE) };
}

async function cleanup() {
  await prisma.feedbackEvidence.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent() {
  return prisma.student.create({
    data: {
      teacherId: TEACHER_ID,
      name: '显式审计学生',
      grade: '高一',
      source: 'test',
    },
  });
}

function feedbackInput(studentId: string, withEvidence = false) {
  return {
    teacherId: TEACHER_ID,
    studentId,
    title: '阶段反馈',
    content: '本周学习状态稳定',
    channel: 'wechat',
    parentName: '学生家长',
    ...(withEvidence
      ? {
        evidence: [{
          type: 'assessment' as const,
          occurredAt: '2031-12-31T10:00:00Z',
          score: 96,
        }],
      }
      : {}),
  };
}

async function logsFor(targetId: string) {
  const result = await changelogQueryService.queryChangeLogs({
    teacherId: TEACHER_ID,
    targetType: 'ParentFeedback',
    targetId,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('query changelog failed');
  return result.value.items;
}

beforeEach(cleanup);
afterEach(cleanup);

describe('ParentFeedback create explicit audit atomicity', () => {
  it('raw tenant client 也显式写入恰好一条 canonical 明文审计', async () => {
    const student = await createStudent();
    const service = createFeedbackService({
      prisma,
      cipher,
      trustedClock: fixedClock(),
    });

    const result = await service.createFeedback(feedbackInput(student.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const logs = await logsFor(result.value.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].before).toBeNull();
    expect(logs[0].after).toEqual({
      id: result.value.id,
      teacherId: TEACHER_ID,
      studentId: student.id,
      lessonId: null,
      title: '阶段反馈',
      content: '本周学习状态稳定',
      status: 'draft',
      channel: 'wechat',
      parentName: '学生家长',
      sentAtTs: null,
      moderationFlagged: null,
      moderationReasons: null,
      createdAtTs: CLOCK_VALUE.toISOString(),
      updatedAtTs: CLOCK_VALUE.toISOString(),
    });
  });

  it('extended client 下 suppression 保证自动与显式审计合计恰好一条', async () => {
    const student = await createStudent();
    const extended = withChangelog(
      prisma,
      createChangelogService(prisma, cipher),
    ) as unknown as PrismaClient;
    const service = createFeedbackService({
      prisma: extended,
      cipher,
      trustedClock: fixedClock(),
    });

    const result = await service.createFeedback(feedbackInput(student.id, true));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await logsFor(result.value.id)).toHaveLength(1);
    expect(await prisma.feedbackContextSnapshot.count({
      where: { teacherId: TEACHER_ID, feedbackId: result.value.id },
    })).toBe(1);
  });

  it('无 evidence 时审计 Err 回滚反馈且不泄漏底层错误', async () => {
    const student = await createStudent();
    const options = {
      prisma,
      cipher,
      trustedClock: fixedClock(),
      changelogFactory: failingChangelogFactory,
    };
    const service = createFeedbackService(options);

    const result = await service.createFeedback(feedbackInput(student.id));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('有 evidence 时审计 Err 回滚反馈、快照、证据和日志', async () => {
    const student = await createStudent();
    const options = {
      prisma,
      cipher,
      trustedClock: fixedClock(),
      changelogFactory: failingChangelogFactory,
    };
    const service = createFeedbackService(options);

    const result = await service.createFeedback(feedbackInput(student.id, true));

    expect(result.ok).toBe(false);
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('复用 outer TransactionClient，外层回滚不留下孤立自动审计', async () => {
    const student = await createStudent();
    const extended = withChangelog(
      prisma,
      createChangelogService(prisma, cipher),
    ) as unknown as PrismaClient;

    await expect(extended.$transaction(async (tx) => {
      const service = createFeedbackService({
        prisma: tx,
        cipher,
        trustedClock: fixedClock(),
      });
      const result = await service.createFeedback(feedbackInput(student.id));
      expect(result.ok).toBe(true);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('借用 outer TransactionClient 时 audit Err 必须以固定安全 sentinel reject 并回滚全部写入', async () => {
    const student = await createStudent();
    const outer = prisma.$transaction(async (tx) => {
      const service = createFeedbackService({
        prisma,
        getClient: async () => tx,
        cipher,
        trustedClock: fixedClock(),
        changelogFactory: failingChangelogFactory,
      });
      return service.createFeedback(feedbackInput(student.id));
    });

    const rejection = await captureRejectedError(outer);
    expect(rejection.message).toContain(PARENT_FEEDBACK_CREATE_ROLLBACK_MESSAGE);
    expect(rejection.message).not.toContain(AUDIT_SECRET);
    await expectCreateRowsRolledBack();
  });

  it('借用 extended outer TransactionClient 时 evidence DB-stage failure 在反馈和审计写后以固定 sentinel reject', async () => {
    const student = await createStudent();
    const executed: string[] = [];
    let successfulChangelogWrites = 0;
    const faulting = faultingEvidenceClient(executed);
    const outer = faulting.$transaction(async (tx) => {
      const service = createFeedbackService({
        prisma: faulting,
        getClient: async () => tx,
        cipher,
        trustedClock: fixedClock(),
        changelogFactory: trackingChangelogFactory(() => {
          successfulChangelogWrites += 1;
          executed.push('changelog');
        }),
      });
      return service.createFeedback(feedbackInput(student.id, true));
    });

    const rejection = await captureRejectedError(outer);
    expect(rejection.message).toContain(PARENT_FEEDBACK_CREATE_ROLLBACK_MESSAGE);
    expect(rejection.message).not.toContain(EVIDENCE_DB_SECRET);
    expect(successfulChangelogWrites).toBe(1);
    expect(executed).toEqual(['feedback', 'changelog', 'evidence']);
    await expectCreateRowsRolledBack();
  });

  it('root client 的 audit Err 仍还原为 Result.Err，且全部写入为零', async () => {
    const student = await createStudent();
    const service = createFeedbackService({
      prisma,
      cipher,
      trustedClock: fixedClock(),
      changelogFactory: failingChangelogFactory,
    });

    const result = await service.createFeedback(feedbackInput(student.id, true));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(AUDIT_SECRET);
    await expectCreateRowsRolledBack();
  });
});
