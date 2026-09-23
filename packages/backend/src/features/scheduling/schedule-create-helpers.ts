import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { err, ok, validationError, versionConflict, type CommonError, type Result } from '@teacher-platform/contracts';
import { type FieldCipher } from '../../shared/field-encryption/index.js';
import { hasLessonOccurrenceConflict } from '../../shared/lesson-occurrence-conflict/index.js';
import { sameScheduleRequest, scheduleInclude, toScheduleData } from './schedule-data.js';
import type { CreateScheduleInput, CreateScheduleResult } from './types.js';

export type CreateScheduleResultOutcome = Result<CreateScheduleResult, CommonError>;

export function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export async function runFormalLessonTransaction(args: {
  prisma: PrismaClient;
  input: CreateScheduleInput;
  cipher?: FieldCipher;
  createInTransaction: (tx: Prisma.TransactionClient) => Promise<CreateScheduleResultOutcome>;
}): Promise<CreateScheduleResultOutcome> {
  const { prisma, input, cipher, createInTransaction } = args;
  let caught: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(createInTransaction, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      caught = error;
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)
        || error.code !== 'P2034'
        || attempt === 3) break;
    }
  }

  if (caught !== undefined) {
    if (caught instanceof Prisma.PrismaClientKnownRequestError
      && (caught.code === 'P2002' || caught.code === 'P2034')
      && input.clientRequestId) {
      const replay = await prisma.schedule.findFirst({
        where: { teacherId: input.teacherId, clientRequestId: input.clientRequestId },
        include: scheduleInclude,
      });
      if (replay && sameScheduleRequest(replay, input, cipher)) {
        return ok({ schedule: toScheduleData(replay, cipher), conflicts: [] });
      }
      if (replay) return err(versionConflict());
    }
    if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2034'
      && await hasLessonOccurrenceConflict(prisma, input.teacherId, {
        start: input.scheduledStart,
        end: input.scheduledEnd,
      })) {
      return err(validationError('该时段与现有排期冲突', 'scheduledStart'));
    }
    if (caught instanceof Prisma.PrismaClientKnownRequestError
      && (caught.code === 'P2002' || caught.code === 'P2034')) {
      return err(versionConflict());
    }
    throw caught;
  }

  throw new Error('formal lesson transaction did not produce a result');
}

export function validateDailyReviewWindow(input: {
  teacherId: string;
  windowStart: Date;
  windowEndExclusive: Date;
}) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 无效', 'teacherId'));
  }
  if (!isValidDate(input.windowStart) || !isValidDate(input.windowEndExclusive)) {
    return err(validationError('每日回顾时间窗口无效', 'windowStart'));
  }
  if (input.windowEndExclusive <= input.windowStart) {
    return err(validationError('每日回顾结束时间必须晚于开始时间', 'windowEndExclusive'));
  }
  return ok(true);
}
