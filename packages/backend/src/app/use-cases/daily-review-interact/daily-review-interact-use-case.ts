import type { Prisma } from '@prisma/client';
import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createAiNoteService } from '../../../features/ai-notes/index.js';
import type { AiNoteData } from '../../../features/ai-notes/index.js';
import { createDailyReviewService } from '../../../features/daily-review/index.js';
import type { DailyReviewData } from '../../../features/daily-review/index.js';
import { createLessonService } from '../../../features/lessons/index.js';
import type { LessonData, LessonStatus } from '../../../features/lessons/index.js';
import {
  createChangelogService,
  requireChangelogWrite,
  runWithAutomaticChangelogSuppressed,
} from '../../../shared/changelog/index.js';
import { createFieldCipherFromEnv } from '../../../shared/field-encryption/index.js';
import type {
  CreateDailyReviewInteractUseCaseOptions,
  DailyReviewInteractResult,
  DailyReviewInteractUseCase,
  InteractDailyReviewInput,
} from './types.js';

const ROLLBACK_MESSAGE = 'daily-review-interact transaction rollback';
const SAFE_FAILURE_MESSAGE = '每日回顾交互失败';

class DailyReviewInteractTransactionRollback extends Error {
  constructor(readonly result: Result<DailyReviewInteractResult, CommonError>) {
    super(ROLLBACK_MESSAGE);
  }
}

interface PrismaClientLike {
  $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
}

export function createDailyReviewInteractUseCase(
  options: CreateDailyReviewInteractUseCaseOptions,
): DailyReviewInteractUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const changelogFactory = options.changelogFactory
    ?? ((client: Prisma.TransactionClient) => createChangelogService(client, cipher));
  const aiNotes = createAiNoteService({
    prisma: options.prisma,
    aiClient: options.aiClient,
    storage: options.storage,
    cipher,
  });

  return {
    async interactDailyReview(input: InteractDailyReviewInput) {
      const parsed = await aiNotes.parseInput({
        teacherId: input.teacherId,
        inputType: 'text',
        text: input.text,
      });
      if (!parsed.ok) return parsed;

      if (parsed.value.intent !== 'review_input') {
        return err(validationError('每日回顾交互只接受 review_input 意图', 'intent'));
      }

      const extractedData = parsed.value.extractedData ?? {};
      const lessonId = readRequiredString(extractedData.lessonId, 'lessonId');
      if (!lessonId.ok) return lessonId;
      const targetStatus = readLessonStatus(extractedData.targetStatus);
      if (!targetStatus.ok) return targetStatus;

      const reviewDate = getReviewDate(input.date);
      const prisma = await getClient();
      const opensTransaction = '$transaction' in prisma
        && typeof (prisma as { $transaction?: unknown }).$transaction === 'function';

      const execute = async (tx: Prisma.TransactionClient) => {
        try {
          const txAiNotes = createAiNoteService({
            prisma: tx,
            aiClient: options.aiClient,
            storage: options.storage,
            cipher,
          });
          const lessons = createLessonService({ getClient: async () => tx, cipher });
          const dailyReview = createDailyReviewService(tx);
          const changelog = changelogFactory(tx);

          const beforeLesson = requireValue(await lessons.getOwnedLesson({
            teacherId: input.teacherId,
            lessonId: lessonId.value,
          }));
          const beforeReview = requireValue(await dailyReview.getReview({
            teacherId: input.teacherId,
            date: reviewDate,
          }));

          const updatedLesson = requireValue(await lessons.updateLessonStatus({
            lessonId: lessonId.value,
            targetStatus: targetStatus.value,
          }));
          await requireChangelogWrite(changelog.recordChange({
            teacherId: input.teacherId,
            module: 'lessons',
            action: 'update',
            targetType: 'Lesson',
            targetId: updatedLesson.id,
            before: toLessonAuditData(beforeLesson),
            after: toLessonAuditData(updatedLesson),
            source: 'agent',
          }));

          const correction = {
            lessonId: lessonId.value,
            fromStatus: beforeLesson.status,
            toStatus: targetStatus.value,
            note: readOptionalString(extractedData.correctionNote) ?? input.text,
            rawInput: input.text,
          };
          const review = requireValue(await dailyReview.appendCorrection({
            teacherId: input.teacherId,
            date: reviewDate,
            correction,
          }));
          await requireChangelogWrite(changelog.recordChange({
            teacherId: input.teacherId,
            module: 'daily-review',
            action: 'update',
            targetType: 'DailyReview',
            targetId: review.id,
            before: toDailyReviewAuditData(beforeReview),
            after: toDailyReviewAuditData(review),
            source: 'agent',
          }));

          const note = requireValue(await txAiNotes.saveNote({
            teacherId: input.teacherId,
            inputType: parsed.value.inputType,
            rawInput: parsed.value.rawInput,
            audioFileRef: parsed.value.audioFileRef,
            intent: parsed.value.intent,
            extractedData,
            confidence: parsed.value.confidence,
            pendingFields: parsed.value.pendingFields,
            status: parsed.value.status,
            routedTo: 'daily-review',
            routedModuleId: review.id,
          }));
          await requireChangelogWrite(changelog.recordChange({
            teacherId: input.teacherId,
            module: 'ai-notes',
            action: 'create',
            targetType: 'AINote',
            targetId: note.id,
            before: null,
            after: toAiNoteAuditData(note),
            source: 'agent',
          }));

          return ok({ lesson: updatedLesson, review, noteId: note.id });
        } catch (caught) {
          if (caught instanceof DailyReviewInteractTransactionRollback) throw caught;
          throw new DailyReviewInteractTransactionRollback(safeFailure());
        }
      };

      try {
        return await runWithAutomaticChangelogSuppressed(() => (
          opensTransaction
            ? (prisma as PrismaClientLike).$transaction(execute)
            : execute(prisma as Prisma.TransactionClient)
        ));
      } catch (caught) {
        if (caught instanceof DailyReviewInteractTransactionRollback) {
          if (!opensTransaction) throw caught;
          return caught.result;
        }
        if (!opensTransaction) {
          throw new DailyReviewInteractTransactionRollback(safeFailure());
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
  throw new DailyReviewInteractTransactionRollback(
    safeResult as Result<DailyReviewInteractResult, CommonError>,
  );
}

function safeFailure(): Result<DailyReviewInteractResult, CommonError> {
  return err(internalError(SAFE_FAILURE_MESSAGE));
}

function toLessonAuditData(lesson: LessonData) {
  return {
    id: lesson.id,
    teacherId: lesson.teacherId,
    studentId: lesson.studentId,
    scheduleId: lesson.scheduleId,
    dateTs: lesson.date,
    status: lesson.status,
    progress: lesson.progress,
    studentState: lesson.studentState,
    homework: lesson.homework,
    teacherNote: lesson.teacherNote,
    sourceNoteId: lesson.sourceNoteId,
    createdAtTs: lesson.createdAt,
    updatedAtTs: lesson.updatedAt,
  };
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

function toAiNoteAuditData(note: AiNoteData) {
  return {
    id: note.id,
    teacherId: note.teacherId,
    inputType: note.inputType,
    rawInput: note.rawInput,
    audioFileRef: note.audioFileRef ?? null,
    intent: note.intent ?? null,
    extractedData: note.extractedData ?? {},
    confidence: note.confidence ?? null,
    pendingFields: note.pendingFields,
    status: note.status,
    routedTo: note.routedTo ?? null,
    routedModuleId: note.routedModuleId ?? null,
    createdAtTs: note.createdAt,
    updatedAtTs: note.updatedAt,
  };
}

function readRequiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    return err(validationError(`${field} 不能为空`, field));
  }
  return ok(value);
}

function readLessonStatus(value: unknown): Result<LessonStatus, CommonError> {
  if (value === 'attended' || value === 'absent' || value === 'pending') {
    return ok(value);
  }
  return err(validationError('目标课次状态不合法', 'targetStatus'));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getReviewDate(date: Date) {
  const dateText = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return new Date(`${dateText}T00:00:00.000Z`);
}
