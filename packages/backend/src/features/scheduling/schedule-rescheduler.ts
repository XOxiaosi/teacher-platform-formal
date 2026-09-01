import { Prisma, type PrismaClient, type Schedule } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
} from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type {
  RescheduleLessonOwnerInput,
  ScheduleData,
  ScheduleRescheduler,
} from './types.js';

type ScheduleReschedulerPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreateScheduleReschedulerOptions {
  prisma: ScheduleReschedulerPrismaClient;
  trustedClock: TrustedClock;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validateIdentity(input: RescheduleLessonOwnerInput) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.scheduleId !== 'string' || input.scheduleId.trim() === '') {
    return err(validationError('scheduleId 必须是非空字符串', 'scheduleId'));
  }
  if (input.expectedUpdatedAt !== undefined && !validDate(input.expectedUpdatedAt)) {
    return err(validationError('expectedUpdatedAt 无效', 'expectedUpdatedAt'));
  }
  return ok(undefined);
}

function validateReplacement(input: RescheduleLessonOwnerInput) {
  if (!input.replacement || !validDate(input.replacement.scheduledStart)) {
    return err(validationError('scheduledStart 无效', 'scheduledStart'));
  }
  if (!validDate(input.replacement.scheduledEnd)) {
    return err(validationError('scheduledEnd 无效', 'scheduledEnd'));
  }
  if (input.replacement.scheduledEnd <= input.replacement.scheduledStart) {
    return err(validationError('scheduledEnd 必须晚于scheduledStart', 'scheduledEnd'));
  }
  return ok(undefined);
}

function toScheduleData(record: Schedule): ScheduleData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    type: record.type,
    title: record.title,
    scheduledStart: record.scheduledStartTs,
    scheduledEnd: record.scheduledEndTs,
    status: record.status,
    confidence: record.confidence,
    pendingFields: record.pendingFields,
    sourceInput: record.sourceInput,
    parentId: record.parentId,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

function replacementData(
  before: Schedule,
  input: RescheduleLessonOwnerInput,
  token: Date,
): Prisma.ScheduleUncheckedCreateInput {
  return {
    teacherId: before.teacherId,
    studentId: before.studentId,
    type: before.type,
    title: before.title,
    scheduledStartTs: input.replacement.scheduledStart,
    scheduledEndTs: input.replacement.scheduledEnd,
    status: 'planned',
    confidence: before.confidence,
    pendingFields: before.pendingFields === null
      ? Prisma.JsonNull
      : before.pendingFields,
    sourceInput: before.sourceInput,
    parentId: before.id,
    createdAtTs: token,
    updatedAtTs: token,
  };
}

export function createScheduleRescheduler(
  options: CreateScheduleReschedulerOptions,
): ScheduleRescheduler {
  const { prisma, trustedClock } = options;

  return {
    async rescheduleLesson(input) {
      const identity = validateIdentity(input);
      if (!identity.ok) return identity;

      try {
        const before = await prisma.schedule.findFirst({
          where: { teacherId: input.teacherId, id: input.scheduleId },
        });
        if (!before) return err(notFound('日程不存在'));

        if (
          input.expectedUpdatedAt !== undefined
          && input.expectedUpdatedAt.getTime() !== before.updatedAtTs.getTime()
        ) {
          return err(versionConflict());
        }
        if (before.type !== 'lesson') {
          return err(validationError('只允许改期lesson日程', 'type'));
        }
        if (before.status !== 'planned') {
          return err(validationError('只允许改期planned日程', 'status'));
        }

        const replacement = validateReplacement(input);
        if (!replacement.ok) return replacement;
        if (
          input.replacement.scheduledStart.getTime() === before.scheduledStartTs.getTime()
          && input.replacement.scheduledEnd.getTime() === before.scheduledEndTs.getTime()
        ) {
          return err(validationError('改期时间未发生变化', 'replacement'));
        }

        const clockResult = await trustedClock.now();
        if (!clockResult.ok) return clockResult;
        const token = clockResult.value;
        if (!validDate(token) || token.getTime() === before.updatedAtTs.getTime()) {
          return err(internalError('数据库可信版本token不可用'));
        }

        const updated = await prisma.schedule.updateMany({
          where: {
            teacherId: input.teacherId,
            id: input.scheduleId,
            updatedAtTs: before.updatedAtTs,
            status: 'planned',
            type: 'lesson',
          },
          data: { status: 'rescheduled', updatedAtTs: token },
        });
        if (updated.count === 0) {
          const current = await prisma.schedule.findFirst({
            where: { teacherId: input.teacherId, id: input.scheduleId },
            select: { id: true },
          });
          return current ? err(versionConflict()) : err(notFound('日程不存在'));
        }

        const created = await prisma.schedule.create({
          data: replacementData(before, input, token),
        });
        const conflictRows = await prisma.schedule.findMany({
          where: {
            teacherId: input.teacherId,
            status: { in: ['planned', 'extra'] },
            scheduledStartTs: { lt: input.replacement.scheduledEnd },
            scheduledEndTs: { gt: input.replacement.scheduledStart },
            id: { not: created.id },
          },
          orderBy: [
            { scheduledStartTs: 'asc' },
            { scheduledEndTs: 'asc' },
            { id: 'asc' },
          ],
        });

        return ok({
          beforeOriginal: toScheduleData(before),
          original: toScheduleData({ ...before, status: 'rescheduled', updatedAtTs: token }),
          replacement: toScheduleData(created),
          conflicts: conflictRows.map(toScheduleData),
        });
      } catch {
        return err(internalError('日程改期失败'));
      }
    },
  };
}
