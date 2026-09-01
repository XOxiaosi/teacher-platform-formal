import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createDailyReviewInteractUseCase } from '../../../src/app/use-cases/daily-review-interact/index.js';
import {
  createChangelogService,
  withChangelog,
  type ChangelogFactory,
} from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';
import type { AiClient } from '../../../src/shared/ai-client/index.js';
import type { StorageService } from '../../../src/shared/storage/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const changelogQueryService = createChangelogService(prisma, cipher);
const TEACHER_ID = 'test-teacher-daily-review-interact-audit';
const OTHER_TEACHER_ID = 'test-other-daily-review-interact-audit';
const REVIEW_DATE = new Date('2032-04-10T00:00:00.000Z');
const INTERACTION_DATE = new Date('2032-04-10T21:00:00+08:00');
const AUDIT_SECRET = 'daily review audit database secret';
const NOTE_DB_SECRET = 'ai note database stage secret';
const ROLLBACK_MESSAGE = 'daily-review-interact transaction rollback';

const storage: StorageService = {
  save: async () => ok({ fileRef: 'audio/ref', size: 1 }),
};

function aiClientFor(lessonId: string): AiClient {
  return {
    run: async ({ taskType }) => {
      if (taskType === 'intent_recognition') {
        return ok({ intent: 'review_input', confidenceScore: 0.92 });
      }
      return ok({
        lessonId,
        targetStatus: 'attended',
        correctionNote: '这节课实际已上',
      });
    },
  };
}

function useCaseOptions(
  root: PrismaClient,
  lessonId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    prisma: root,
    aiClient: aiClientFor(lessonId),
    storage,
    cipher,
    ...extra,
  } as unknown as Parameters<typeof createDailyReviewInteractUseCase>[0];
}

function interactionInput() {
  return {
    teacherId: TEACHER_ID,
    date: INTERACTION_DATE,
    text: '这节课实际已上',
  };
}

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.aINote.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.dailyReview.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createLessonFixture(teacherId = TEACHER_ID) {
  const student = await prisma.student.create({
    data: { teacherId, name: '回顾审计学生', grade: '高三' },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId,
      studentId: student.id,
      type: 'lesson',
      title: '回顾审计课',
      scheduledStartTs: new Date('2032-04-10T11:00:00Z'),
      scheduledEndTs: new Date('2032-04-10T12:30:00Z'),
      status: 'completed',
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      teacherId,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: new Date('2032-04-10T11:00:00Z'),
      status: 'pending',
    },
  });
  return { student, schedule, lesson };
}

async function createReviewFixture() {
  return prisma.dailyReview.create({
    data: {
      teacherId: TEACHER_ID,
      dateTs: REVIEW_DATE,
      plannedCount: 1,
      actualCount: 0,
      cancelledCount: 0,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 1,
      deviations: [{ type: 'pending', count: 1 }],
      corrections: [],
    },
  });
}

async function createFixture() {
  const lessonFixture = await createLessonFixture();
  const review = await createReviewFixture();
  return { ...lessonFixture, review };
}

async function logsForTeacher() {
  const result = await changelogQueryService.queryChangeLogs({
    teacherId: TEACHER_ID,
    pageSize: 20,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('query changelog failed');
  return result.value.items;
}

async function expectRolledBack(lessonId: string) {
  const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: lessonId } });
  expect(lesson.status).toBe('pending');
  const review = await prisma.dailyReview.findUniqueOrThrow({
    where: { teacherId_dateTs: { teacherId: TEACHER_ID, dateTs: REVIEW_DATE } },
  });
  expect(review.corrections).toEqual([]);
  expect(await prisma.aINote.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
}

function failingAuditAt(failureAt: number, executed: string[] = []): ChangelogFactory {
  return (client) => {
    const real = createChangelogService(client, cipher);
    let callCount = 0;
    return {
      async recordChange(input) {
        callCount += 1;
        executed.push(`audit-${callCount}`);
        if (callCount === failureAt) return err(internalError(AUDIT_SECRET));
        return real.recordChange(input);
      },
    };
  };
}

function trackingBusinessClient(executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      lesson: {
        async update({ args, query }) {
          const result = await query(args);
          executed.push('lesson');
          return result;
        },
      },
      dailyReview: {
        async update({ args, query }) {
          const result = await query(args);
          executed.push('review');
          return result;
        },
      },
      aINote: {
        async create({ args, query }) {
          const result = await query(args);
          executed.push('ai-note');
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}

function trackingAuditFactory(executed: string[]): ChangelogFactory {
  return (client) => {
    const real = createChangelogService(client, cipher);
    let callCount = 0;
    return {
      async recordChange(input) {
        const result = await real.recordChange(input);
        callCount += 1;
        if (result.ok) executed.push(`audit-${callCount}`);
        return result;
      },
    };
  };
}

function faultingAiNoteClient(executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      lesson: {
        async update({ args, query }) {
          const result = await query(args);
          executed.push('lesson');
          return result;
        },
      },
      dailyReview: {
        async update({ args, query }) {
          const result = await query(args);
          executed.push('review');
          return result;
        },
      },
      aINote: {
        async create() {
          executed.push('ai-note');
          throw new Error(NOTE_DB_SECRET);
        },
      },
    },
  }) as unknown as PrismaClient;
}

async function captureRejectedError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected transaction to reject');
}

beforeEach(cleanup);
afterEach(cleanup);

describe('daily-review-interact explicit audit atomicity', () => {
  it('raw tenant client 成功后写入三条 canonical 明文审计', async () => {
    const fixture = await createFixture();
    let clientResolutions = 0;
    const useCase = createDailyReviewInteractUseCase(useCaseOptions(prisma, fixture.lesson.id, {
      getClient: async () => {
        clientResolutions += 1;
        return prisma;
      },
    }));

    const result = await useCase.interactDailyReview(interactionInput());

    expect(result.ok).toBe(true);
    expect(clientResolutions).toBe(1);
    if (!result.ok) return;
    const logs = await logsForTeacher();
    expect(logs).toHaveLength(3);
    const lessonLog = logs.find((item) => item.targetType === 'Lesson');
    const reviewLog = logs.find((item) => item.targetType === 'DailyReview');
    const noteLog = logs.find((item) => item.targetType === 'AINote');
    expect(lessonLog).toMatchObject({
      module: 'lessons', action: 'update', targetId: fixture.lesson.id, source: 'agent',
    });
    expect(lessonLog?.before).toEqual({
      id: fixture.lesson.id,
      teacherId: TEACHER_ID,
      studentId: fixture.student.id,
      scheduleId: fixture.schedule.id,
      dateTs: fixture.lesson.dateTs.toISOString(),
      status: 'pending',
      progress: null,
      studentState: null,
      homework: null,
      teacherNote: null,
      sourceNoteId: null,
      createdAtTs: fixture.lesson.createdAtTs.toISOString(),
      updatedAtTs: fixture.lesson.updatedAtTs.toISOString(),
    });
    expect(lessonLog?.after).toEqual({
      id: result.value.lesson.id,
      teacherId: result.value.lesson.teacherId,
      studentId: result.value.lesson.studentId,
      scheduleId: result.value.lesson.scheduleId,
      dateTs: result.value.lesson.date.toISOString(),
      status: 'attended',
      progress: null,
      studentState: null,
      homework: null,
      teacherNote: null,
      sourceNoteId: null,
      createdAtTs: result.value.lesson.createdAt.toISOString(),
      updatedAtTs: result.value.lesson.updatedAt.toISOString(),
    });
    expect(reviewLog).toMatchObject({
      module: 'daily-review', action: 'update', targetId: fixture.review.id, source: 'agent',
    });
    expect(reviewLog?.before).toEqual({
      id: fixture.review.id,
      teacherId: TEACHER_ID,
      dateTs: fixture.review.dateTs.toISOString(),
      plannedCount: 1,
      actualCount: 0,
      cancelledCount: 0,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 1,
      deviations: [{ type: 'pending', count: 1 }],
      corrections: [],
      tomorrowSuggestion: null,
      createdAtTs: fixture.review.createdAtTs.toISOString(),
      updatedAtTs: fixture.review.updatedAtTs.toISOString(),
    });
    expect(reviewLog?.after).toEqual({
      id: result.value.review.id,
      teacherId: TEACHER_ID,
      dateTs: result.value.review.date.toISOString(),
      plannedCount: 1,
      actualCount: 0,
      cancelledCount: 0,
      missedCount: 0,
      rescheduledCount: 0,
      pendingCount: 1,
      deviations: [{ type: 'pending', count: 1 }],
      corrections: [{
        lessonId: fixture.lesson.id,
        fromStatus: 'pending',
        toStatus: 'attended',
        note: '这节课实际已上',
        rawInput: '这节课实际已上',
      }],
      tomorrowSuggestion: null,
      createdAtTs: result.value.review.createdAt.toISOString(),
      updatedAtTs: result.value.review.updatedAt.toISOString(),
    });
    expect(noteLog).toMatchObject({
      module: 'ai-notes', action: 'create', before: null, source: 'agent',
    });
    expect(noteLog?.targetId).toBe(result.value.noteId);
    expect(noteLog?.after).toEqual({
      id: result.value.noteId,
      teacherId: TEACHER_ID,
      inputType: 'text',
      rawInput: '这节课实际已上',
      audioFileRef: null,
      intent: 'review_input',
      extractedData: {
        type: 'lesson',
        durationMinutes: 90,
        location: '待确认',
        lessonId: fixture.lesson.id,
        targetStatus: 'attended',
        correctionNote: '这节课实际已上',
      },
      confidence: 'high',
      pendingFields: ['studentName'],
      status: 'pending',
      routedTo: 'daily-review',
      routedModuleId: result.value.review.id,
      createdAtTs: expect.any(String),
      updatedAtTs: expect.any(String),
    });
  });

  it('extended root 下 suppression 保证自动与显式审计合计恰好三条', async () => {
    const fixture = await createFixture();
    const extended = withChangelog(
      prisma,
      createChangelogService(prisma, cipher),
    ) as unknown as PrismaClient;
    const useCase = createDailyReviewInteractUseCase(useCaseOptions(extended, fixture.lesson.id));

    const result = await useCase.interactDailyReview(interactionInput());

    expect(result.ok).toBe(true);
    expect(await logsForTeacher()).toHaveLength(3);
  });

  it.each([
    { failureAt: 1, expected: ['lesson', 'audit-1'] },
    { failureAt: 2, expected: ['lesson', 'audit-1', 'review', 'audit-2'] },
    { failureAt: 3, expected: ['lesson', 'audit-1', 'review', 'audit-2', 'ai-note', 'audit-3'] },
  ])('第 $failureAt 条审计失败时回滚全部业务写与此前日志', async ({ failureAt, expected }) => {
    const fixture = await createFixture();
    const executed: string[] = [];
    const tracking = trackingBusinessClient(executed);
    const useCase = createDailyReviewInteractUseCase(useCaseOptions(tracking, fixture.lesson.id, {
      changelogFactory: failingAuditAt(failureAt, executed),
    }));

    const result = await useCase.interactDailyReview(interactionInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect(executed).toEqual(expected);
    await expectRolledBack(fixture.lesson.id);
  });

  it('AINote 数据库阶段失败时回滚已执行的两项业务写与两条审计', async () => {
    const fixture = await createFixture();
    const executed: string[] = [];
    const faulting = faultingAiNoteClient(executed);
    const useCase = createDailyReviewInteractUseCase(useCaseOptions(faulting, fixture.lesson.id, {
      changelogFactory: trackingAuditFactory(executed),
    }));

    const result = await useCase.interactDailyReview(interactionInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(NOTE_DB_SECRET);
    expect(executed).toEqual(['lesson', 'audit-1', 'review', 'audit-2', 'ai-note']);
    await expectRolledBack(fixture.lesson.id);
  });

  it('借用 outer TransactionClient 成功后调用方回滚，三项业务与三条日志全部恢复', async () => {
    const fixture = await createFixture();

    await expect(prisma.$transaction(async (tx) => {
      expect('$transaction' in tx).toBe(false);
      const useCase = createDailyReviewInteractUseCase(useCaseOptions(prisma, fixture.lesson.id, {
        getClient: async () => tx,
      }));
      const result = await useCase.interactDailyReview(interactionInput());
      expect(result.ok).toBe(true);
      const txLogs = await createChangelogService(tx, cipher).queryChangeLogs({
        teacherId: TEACHER_ID,
        pageSize: 20,
      });
      expect(txLogs.ok).toBe(true);
      if (txLogs.ok) expect(txLogs.value.items).toHaveLength(3);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    await expectRolledBack(fixture.lesson.id);
  });

  it('借用 outer TransactionClient 时 audit Err 必须 reject 固定安全 sentinel', async () => {
    const fixture = await createFixture();
    const outer = prisma.$transaction(async (tx) => {
      const useCase = createDailyReviewInteractUseCase(useCaseOptions(prisma, fixture.lesson.id, {
        getClient: async () => tx,
        changelogFactory: failingAuditAt(2),
      }));
      return useCase.interactDailyReview(interactionInput());
    });

    const rejection = await captureRejectedError(outer);
    expect(rejection.message).toBe(ROLLBACK_MESSAGE);
    expect(rejection.message).not.toContain(AUDIT_SECRET);
    expect(JSON.stringify(rejection)).not.toContain(AUDIT_SECRET);
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();
    await expectRolledBack(fixture.lesson.id);
  });

  it('借用 outer TransactionClient 时 AINote Result.Err 也必须 reject 固定安全 sentinel', async () => {
    const fixture = await createFixture();
    const executed: string[] = [];
    const faulting = faultingAiNoteClient(executed);
    const outer = faulting.$transaction(async (tx) => {
      const useCase = createDailyReviewInteractUseCase(useCaseOptions(faulting, fixture.lesson.id, {
        getClient: async () => tx,
        changelogFactory: trackingAuditFactory(executed),
      }));
      return useCase.interactDailyReview(interactionInput());
    });

    const rejection = await captureRejectedError(outer);
    expect(rejection.message).toBe(ROLLBACK_MESSAGE);
    expect(rejection.message).not.toContain(NOTE_DB_SECRET);
    expect(JSON.stringify(rejection)).not.toContain(NOTE_DB_SECRET);
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(executed).toEqual(['lesson', 'audit-1', 'review', 'audit-2', 'ai-note']);
    await expectRolledBack(fixture.lesson.id);
  });

  it('跨教师 lessonId 被安全拒绝且不产生任何写入', async () => {
    const foreign = await createLessonFixture(OTHER_TEACHER_ID);
    await createReviewFixture();
    const useCase = createDailyReviewInteractUseCase(useCaseOptions(prisma, foreign.lesson.id));

    const result = await useCase.interactDailyReview(interactionInput());

    expect(result.ok).toBe(false);
    const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: foreign.lesson.id } });
    expect(lesson.status).toBe('pending');
    const review = await prisma.dailyReview.findUniqueOrThrow({
      where: { teacherId_dateTs: { teacherId: TEACHER_ID, dateTs: REVIEW_DATE } },
    });
    expect(review.corrections).toEqual([]);
    expect(await prisma.aINote.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } })).toBe(0);
  });
});
