import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import { createScheduleService } from '../../../features/scheduling/index.js';
import {
  defaultChangelogFactory,
  runWithAutomaticChangelogSuppressed,
  type ChangelogFactory,
} from '../../../shared/changelog/index.js';
import { createScheduleCompleteUseCaseWithServices } from './schedule-complete-use-case.js';
import type {
  ScheduleCompletePrismaClient,
  ScheduleCompleteServices,
} from './types.js';

class TransactionRollback<T> extends Error {
  constructor(readonly result: Result<T, CommonError>) {
    super('schedule-complete transaction rollback');
  }
}

export interface ScheduleCompleteUseCaseOptions {
  getClient: () => Promise<ScheduleCompletePrismaClient>;
  changelogFactory?: ChangelogFactory;
}

function isScheduleCompleteOptions(
  value: PrismaClient | ScheduleCompleteUseCaseOptions,
): value is ScheduleCompleteUseCaseOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ScheduleCompleteUseCaseOptions).getClient === 'function';
}

export function createScheduleCompleteUseCase(
  prismaOrOptions: PrismaClient | ScheduleCompleteUseCaseOptions,
) {
  const getClient = isScheduleCompleteOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const changelogFactory = isScheduleCompleteOptions(prismaOrOptions)
    ? (prismaOrOptions.changelogFactory ?? defaultChangelogFactory)
    : defaultChangelogFactory;

  const services: ScheduleCompleteServices = {
    async transaction(fn) {
      const prisma = await getClient();
      const execute = async (tx: Prisma.TransactionClient) => {
        const result = await fn({
          scheduling: createScheduleService(tx),
          lessons: createLessonService(tx),
          changelog: changelogFactory(tx),
        });
        if (!result.ok) throw new TransactionRollback(result);
        return result;
      };

      const opensTransaction = '$transaction' in prisma
        && typeof (prisma as { $transaction?: unknown }).$transaction === 'function';
      try {
        return await runWithAutomaticChangelogSuppressed(() => (
          opensTransaction
            ? (prisma as PrismaClient).$transaction(execute)
            : execute(prisma as Prisma.TransactionClient)
        ));
      } catch (error) {
        if (error instanceof TransactionRollback) {
          // 只有自己创建的事务才能安全地把 rollback 异常还原成 Result。
          // 复用外层 tx 时必须继续抛出，否则调用方可能正常提交已经发生的写入。
          if (!opensTransaction) throw error;
          return error.result;
        }
        throw error;
      }
    },
  };

  return createScheduleCompleteUseCaseWithServices(services);
}

export { createScheduleCompleteUseCaseWithServices };
export type {
  ScheduleCompleteFactory,
  ScheduleCompleteInput,
  ScheduleCompleteOutput,
  ScheduleCompletePrismaClient,
  ScheduleCompleteServices,
  ScheduleCompleteTransactionalServices,
  ScheduleCompleteUseCase,
} from './types.js';
