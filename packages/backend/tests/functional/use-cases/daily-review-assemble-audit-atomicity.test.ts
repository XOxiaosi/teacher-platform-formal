import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createDailyReviewAssembleUseCase } from '../../../src/app/use-cases/daily-review-assemble/index.js';
import { createCoreRouteDependencies } from '../../../src/app/composition/core-route-dependencies.js';
import {
  createChangelogService,
  withChangelog,
  type ChangelogFactory,
} from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';
import { runWithRequestDb } from '../../../src/shared/database-pool/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const changelogQuery = createChangelogService(prisma, cipher);
const TEACHER_ID = 'test-teacher-daily-review-assemble-audit';
const REVIEW_DATE = '2033-05-10';
const AUDIT_SECRET = 'daily review assemble audit failure secret';
const DB_SECRET = 'daily review assemble database failure secret';
const ROLLBACK_MESSAGE = 'daily-review-assemble transaction rollback';

function clockAt(instant = new Date('2035-01-01T00:00:00.000Z')) {
  return { now: vi.fn(async () => ok(instant)) };
}

function useCaseOptions(root: PrismaClient, extra: Record<string, unknown> = {}) {
  return {
    prisma: root,
    trustedClock: clockAt(),
    cipher,
    ...extra,
  } as unknown as Parameters<typeof createDailyReviewAssembleUseCase>[0];
}

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.dailyReview.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createFixture() {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER_ID, name: '组装审计学生', grade: '高二' },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      type: 'lesson',
      title: '组装审计课程',
      scheduledStartTs: new Date('2033-05-10T01:00:00.000Z'),
      scheduledEndTs: new Date('2033-05-10T02:30:00.000Z'),
      status: 'completed',
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: new Date('2033-05-10T01:00:00.000Z'),
      status: 'attended',
    },
  });
  return { student, schedule, lesson };
}

async function logsForTeacher() {
  const result = await changelogQuery.queryChangeLogs({ teacherId: TEACHER_ID, pageSize: 20 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('query changelog failed');
  return result.value.items;
}

async function expectNoPersistedWrites() {
  expect(await prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
}

function expectCanonicalSystemLog(log: Awaited<ReturnType<typeof logsForTeacher>>[number], review: {
  id: string;
  teacherId: string;
  date: Date;
  plannedCount: number;
  actualCount: number;
  cancelledCount: number;
  missedCount: number;
  rescheduledCount: number;
  pendingCount: number;
  deviations: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
}) {
  expect(log).toMatchObject({
    teacherId: TEACHER_ID,
    module: 'daily-review',
    action: 'create',
    targetType: 'DailyReview',
    targetId: review.id,
    source: 'system',
    before: null,
  });
  expect(log.after).toEqual({
    id: review.id,
    teacherId: review.teacherId,
    dateTs: review.date.toISOString(),
    plannedCount: review.plannedCount,
    actualCount: review.actualCount,
    cancelledCount: review.cancelledCount,
    missedCount: review.missedCount,
    rescheduledCount: review.rescheduledCount,
    pendingCount: review.pendingCount,
    deviations: review.deviations,
    corrections: review.corrections,
    tomorrowSuggestion: null,
    createdAtTs: review.createdAt.toISOString(),
    updatedAtTs: review.updatedAt.toISOString(),
  });
  expect(Object.keys(log.after ?? {}).sort()).toEqual([
    'actualCount', 'cancelledCount', 'corrections', 'createdAtTs', 'dateTs',
    'deviations', 'id', 'missedCount', 'pendingCount', 'plannedCount',
    'rescheduledCount', 'teacherId', 'tomorrowSuggestion', 'updatedAtTs',
  ]);
}

function failingAuditFactory(executed: string[]): ChangelogFactory {
  return () => ({
    async recordChange() {
      executed.push('audit');
      return err(internalError(AUDIT_SECRET));
    },
  });
}

function trackingCreateClient(executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      dailyReview: {
        async create({ args, query }) {
          const result = await query(args);
          executed.push('review');
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}

function throwingCreateClient(executed: string[]): PrismaClient {
  return prisma.$extends({
    query: {
      dailyReview: {
        async create() {
          executed.push('review');
          throw new Error(DB_SECRET);
        },
      },
    },
  }) as unknown as PrismaClient;
}

async function rejectedError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected transaction to reject');
}

beforeEach(cleanup);
afterEach(cleanup);

describe('daily-review-assemble explicit audit atomicity', () => {
  it('raw root resolves once and atomically writes one canonical plaintext system DailyReview audit', async () => {
    await createFixture();
    let resolutions = 0;
    const transaction = vi.spyOn(prisma, '$transaction');
    const useCase = createDailyReviewAssembleUseCase(useCaseOptions(prisma, {
      getClient: async () => {
        resolutions += 1;
        return prisma;
      },
    }));

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });

    expect(result.ok).toBe(true);
    expect(resolutions).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    if (!result.ok) return;
    const logs = await logsForTeacher();
    expect(logs).toHaveLength(1);
    expectCanonicalSystemLog(logs[0], result.value.review);
  });

  it('extended root suppresses automatic audit and leaves exactly one canonical explicit system audit', async () => {
    await createFixture();
    const automaticCalls: string[] = [];
    const automatic = createChangelogService(prisma, cipher);
    const extended = withChangelog(prisma, {
      ...automatic,
      async recordChange(input) {
        automaticCalls.push(input.targetType);
        return automatic.recordChange(input);
      },
    }) as unknown as PrismaClient;
    const explicitCalls: string[] = [];
    const useCase = createDailyReviewAssembleUseCase(useCaseOptions(extended, {
      getClient: async () => extended,
      changelogFactory: (tx) => ({
        async recordChange(input) {
          explicitCalls.push(input.targetType);
          return createChangelogService(tx, cipher).recordChange(input);
        },
      }),
    }));

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });

    expect(result.ok).toBe(true);
    expect(automaticCalls).toEqual([]);
    expect(explicitCalls).toEqual(['DailyReview']);
    if (!result.ok) return;
    const logs = await logsForTeacher();
    expect(logs).toHaveLength(1);
    expectCanonicalSystemLog(logs[0], result.value.review);
  });

  it('audit failure after DailyReview create rolls back both records and returns a secret-free Result.Err', async () => {
    await createFixture();
    const executed: string[] = [];
    const tracking = trackingCreateClient(executed);
    const useCase = createDailyReviewAssembleUseCase(useCaseOptions(tracking, {
      getClient: async () => tracking,
      changelogFactory: failingAuditFactory(executed),
    }));

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect(executed).toEqual(['review', 'audit']);
    await expectNoPersistedWrites();
  });

  it('DailyReview database throw after its attempted create rolls back and returns a secret-free Result.Err', async () => {
    await createFixture();
    const executed: string[] = [];
    const faulting = throwingCreateClient(executed);
    const useCase = createDailyReviewAssembleUseCase(useCaseOptions(faulting, {
      getClient: async () => faulting,
    }));

    const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(DB_SECRET);
    expect(executed).toEqual(['review']);
    await expectNoPersistedWrites();
  });

  it('borrowed outer TransactionClient creates one audit without nesting, and caller rollback clears both records', async () => {
    await createFixture();
    let resolutions = 0;

    await expect(prisma.$transaction(async (tx) => {
      expect('$transaction' in tx).toBe(false);
      const useCase = createDailyReviewAssembleUseCase(useCaseOptions(prisma, {
        getClient: async () => {
          resolutions += 1;
          return tx;
        },
      }));
      const result = await useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });
      expect(result.ok).toBe(true);
      expect(resolutions).toBe(1);
      const txLogs = await createChangelogService(tx, cipher).queryChangeLogs({
        teacherId: TEACHER_ID,
        pageSize: 20,
      });
      expect(txLogs.ok).toBe(true);
      if (txLogs.ok) expect(txLogs.value.items).toHaveLength(1);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    await expectNoPersistedWrites();
  });

  it('borrowed audit Err rejects the fixed sentinel without its injected secret and rolls back outer work', async () => {
    await createFixture();
    const outer = prisma.$transaction(async (tx) => {
      const useCase = createDailyReviewAssembleUseCase(useCaseOptions(prisma, {
        getClient: async () => tx,
        changelogFactory: failingAuditFactory([]),
      }));
      return useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });
    });

    const rejection = await rejectedError(outer);
    expect(rejection.message).toBe(ROLLBACK_MESSAGE);
    expect(rejection.message).not.toContain(AUDIT_SECRET);
    expect(JSON.stringify(rejection)).not.toContain(AUDIT_SECRET);
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();
    await expectNoPersistedWrites();
  });

  it('borrowed DailyReview DB-stage throw rejects the fixed sentinel without its DB secret and rolls back outer work', async () => {
    await createFixture();
    const executed: string[] = [];
    const faulting = throwingCreateClient(executed);
    const outer = faulting.$transaction(async (tx) => {
      const useCase = createDailyReviewAssembleUseCase(useCaseOptions(faulting, {
        getClient: async () => tx,
      }));
      return useCase.assembleDailyReview({ teacherId: TEACHER_ID, date: REVIEW_DATE });
    });

    const rejection = await rejectedError(outer);
    expect(executed).toEqual(['review']);
    expect(rejection.message).toBe(ROLLBACK_MESSAGE);
    expect(rejection.message).not.toContain(DB_SECRET);
    expect(JSON.stringify(rejection)).not.toContain(DB_SECRET);
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();
    await expectNoPersistedWrites();
  });

  it('core-route composition routes Schedule, Lesson, DailyReview, and trusted-clock work to request databaseRouter client', async () => {
    await createFixture();
    let rootReadsOrWrites = 0;
    const root = prisma.$extends({
      query: {
        $queryRaw({ args, query }) {
          rootReadsOrWrites += 1;
          return query(args);
        },
        $allModels: {
          async $allOperations({ args, query }) {
            rootReadsOrWrites += 1;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const routedOperations: string[] = [];
    const routed = prisma.$extends({
      query: {
        $queryRaw({ args, query }) {
          routedOperations.push('$queryRaw');
          return query(args);
        },
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            routedOperations.push(`${model ?? 'raw'}.${operation}`);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const dependencies = createCoreRouteDependencies(root, { trustedClock: clockAt() });

    const result = await runWithRequestDb({ client: routed, dbName: 'daily_review_routed' }, () => (
      dependencies.dailyReview.dailyReview.assembleDailyReview({
        teacherId: TEACHER_ID,
        date: REVIEW_DATE,
      })
    ));

    expect(result.ok).toBe(true);
    expect(rootReadsOrWrites).toBe(0);
    expect(routedOperations).toEqual(expect.arrayContaining([
      'Schedule.findMany',
      'Lesson.findMany',
      'DailyReview.create',
      '$queryRaw',
    ]));
    expect(await prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
  });
});
