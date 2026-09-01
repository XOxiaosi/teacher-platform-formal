import type { Prisma } from '@prisma/client';
import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createDailyReviewService } from '../../../features/daily-review/index.js';
import type { DailyReviewData } from '../../../features/daily-review/index.js';
import { createLessonService } from '../../../features/lessons/index.js';
import type { LessonData } from '../../../features/lessons/index.js';
import { createScheduleService } from '../../../features/scheduling/index.js';
import type { ScheduleData } from '../../../features/scheduling/index.js';
import {
  createChangelogService,
  requireChangelogWrite,
  runWithAutomaticChangelogSuppressed,
} from '../../../shared/changelog/index.js';
import { createFieldCipherFromEnv } from '../../../shared/field-encryption/index.js';
import { parseBusinessDate, projectShanghaiBusinessDate } from './business-date.js';
import type {
  AssembleDailyReviewInput,
  CreateDailyReviewAssembleUseCaseOptions,
  DailyReviewAssembleResult,
  DailyReviewAssembleUseCase,
} from './types.js';

const ROLLBACK_MESSAGE = 'daily-review-assemble transaction rollback';
const SAFE_FAILURE_MESSAGE = '每日回顾组装失败';

class DailyReviewAssembleTransactionRollback extends Error {
  constructor(readonly result: Result<DailyReviewAssembleResult, CommonError>) {
    super(ROLLBACK_MESSAGE);
  }
}

interface PrismaClientLike {
  $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
}

export function createDailyReviewAssembleUseCase(
  options: CreateDailyReviewAssembleUseCaseOptions,
): DailyReviewAssembleUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx, cipher));

  return {
    async assembleDailyReview(input: AssembleDailyReviewInput) {
      if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
        return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
      }

      const businessDate = input.date !== undefined
        ? parseBusinessDate(input.date)
        : await readDefaultBusinessDate(options);
      if (!businessDate.ok) return businessDate;

      const window = {
        teacherId: input.teacherId,
        windowStart: businessDate.value.windowStart,
        windowEndExclusive: businessDate.value.windowEndExclusive,
      };
      const prisma = await getClient();
      const opensTransaction = '$transaction' in prisma
        && typeof (prisma as { $transaction?: unknown }).$transaction === 'function';

      const execute = async (tx: Prisma.TransactionClient) => {
        try {
          const schedules = createScheduleService({ getClient: async () => tx });
          const lessons = createLessonService({ getClient: async () => tx });
          const dailyReview = createDailyReviewService(tx);
          const changelog = changelogFactory(tx);

          const scheduleList = requireValue(await schedules.listSchedulesStartingInWindow(window));
          const lessonList = requireValue(await lessons.listLessonsInWindow(window));
          const deviation = requireValue(dailyReview.calculateDeviation({
            plannedSchedules: toScheduleStatusItems(scheduleList.items),
            actualLessons: toLessonStatusItems(lessonList.items),
            memoTasks: toPendingScheduleItems(scheduleList.items),
          }));
          const review = requireValue(await dailyReview.createReview({
            teacherId: input.teacherId,
            date: businessDate.value.reviewDate,
            plannedCount: deviation.plannedCount,
            actualCount: deviation.actualCount,
            cancelledCount: deviation.cancelledCount,
            missedCount: deviation.missedCount,
            rescheduledCount: deviation.rescheduledCount,
            pendingCount: deviation.pendingCount,
            deviations: deviation.deviations,
            corrections: [],
          }));
          await requireChangelogWrite(changelog.recordChange({
            teacherId: input.teacherId,
            module: 'daily-review',
            action: 'create',
            targetType: 'DailyReview',
            targetId: review.id,
            before: null,
            after: toDailyReviewAuditData(review),
            source: 'system',
          }));

          return ok({
            review,
            schedules: scheduleList.items,
            lessons: lessonList.items,
          });
        } catch (caught) {
          if (caught instanceof DailyReviewAssembleTransactionRollback) throw caught;
          throw new DailyReviewAssembleTransactionRollback(safeFailure());
        }
      };

      try {
        return await runWithAutomaticChangelogSuppressed(() => (
          opensTransaction
            ? (prisma as PrismaClientLike).$transaction(execute)
            : execute(prisma as Prisma.TransactionClient)
        ));
      } catch (caught) {
        if (caught instanceof DailyReviewAssembleTransactionRollback) {
          if (!opensTransaction) throw caught;
          return caught.result;
        }
        if (!opensTransaction) {
          throw new DailyReviewAssembleTransactionRollback(safeFailure());
        }
        return safeFailure();
      }
    },
  };
}

function requireValue<T>(result: Result<T, CommonError>): T {
  if (result.ok) return result.value;
  const safeResult = result.error.code === 'INTERNAL_ERROR'
    ? safeFailure()
    : result;
  throw new DailyReviewAssembleTransactionRollback(
    safeResult as Result<DailyReviewAssembleResult, CommonError>,
  );
}

function safeFailure(): Result<DailyReviewAssembleResult, CommonError> {
  return err(internalError(SAFE_FAILURE_MESSAGE));
}

async function readDefaultBusinessDate(options: CreateDailyReviewAssembleUseCaseOptions) {
  const now = await options.trustedClock.now();
  if (!now.ok) return now;
  return projectShanghaiBusinessDate(now.value);
}

function toDailyReviewAuditData(review: DailyReviewData) {
  return {
    id: review.id,
    teacherId: review.teacherId,
    dateTs: review.date,
    plannedCount: review.plannedCount,
    actualCount: review.actualCount,
    cancelledCount: review.cancelledCount,
    missedCount: review.missedCount,
    rescheduledCount: review.rescheduledCount,
    pendingCount: review.pendingCount,
    deviations: review.deviations,
    corrections: review.corrections,
    tomorrowSuggestion: review.tomorrowSuggestion ?? null,
    createdAtTs: review.createdAt,
    updatedAtTs: review.updatedAt,
  };
}

function pendingFieldNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toScheduleStatusItems(schedules: ScheduleData[]) {
  return schedules.map((schedule) => ({
    id: schedule.id,
    title: schedule.title,
    status: schedule.status,
    pendingFields: pendingFieldNames(schedule.pendingFields),
  }));
}

function toLessonStatusItems(lessons: LessonData[]) {
  return lessons.map((lesson) => ({ id: lesson.id, status: lesson.status }));
}

function toPendingScheduleItems(schedules: ScheduleData[]) {
  return schedules
    .filter((schedule) => pendingFieldNames(schedule.pendingFields).length > 0)
    .map((schedule) => ({
      id: schedule.id,
      title: schedule.title,
      status: 'pending',
      pendingFields: pendingFieldNames(schedule.pendingFields),
    }));
}
