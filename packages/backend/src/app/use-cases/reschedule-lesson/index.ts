import type { Prisma, PrismaClient } from '@prisma/client';
import {
  err,
  internalError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import { createScheduleRescheduler } from '../../../features/scheduling/index.js';
import {
  createChangelogService,
  type ChangelogService,
} from '../../../shared/changelog/index.js';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../../shared/trusted-clock/index.js';
import { createRescheduleLessonUseCaseWithServices } from './reschedule-lesson-use-case.js';
import type { RescheduleLessonServices } from './types.js';

export type ScheduleRescheduleTrustedClockFactory = (
  tx: Prisma.TransactionClient,
) => TrustedClock;

export type ScheduleRescheduleChangelogFactory = (
  tx: Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;

export interface CreateRescheduleLessonUseCaseOptions {
  rawPrisma: PrismaClient;
  trustedClockFactory?: ScheduleRescheduleTrustedClockFactory;
  changelogFactory?: ScheduleRescheduleChangelogFactory;
}

class ScheduleRescheduleTransactionRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('schedule-reschedule transaction rollback');
  }
}

export function createRescheduleLessonUseCase(
  options: CreateRescheduleLessonUseCaseOptions,
) {
  const trustedClockFactory = options.trustedClockFactory
    ?? ((tx: Prisma.TransactionClient) => createDatabaseTrustedClock(tx));
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx));

  const services: RescheduleLessonServices = {
    async transaction<T>(work: Parameters<RescheduleLessonServices['transaction']>[0]) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            scheduling: createScheduleRescheduler({
              prisma: tx,
              trustedClock: trustedClockFactory(tx),
            }),
            changelog: changelogFactory(tx),
          });
          if (!result.ok) throw new ScheduleRescheduleTransactionRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof ScheduleRescheduleTransactionRollback) {
          return caught.result as Result<T, CommonError>;
        }
        return err(internalError('日程改期事务失败'));
      }
    },
  };

  return createRescheduleLessonUseCaseWithServices(services);
}

export { createRescheduleLessonUseCaseWithServices };
export type {
  RescheduleLessonCommand,
  RescheduleLessonOwnerInput,
  RescheduleLessonOwnerResult,
  RescheduleLessonResult,
  RescheduleLessonServices,
  RescheduleLessonTransactionalServices,
  RescheduleLessonUseCase,
} from './types.js';
