import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createLessonRecordEditor } from '../../../features/lessons/index.js';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';
import {
  createChangelogService,
  type ChangelogService,
} from '../../../shared/changelog/index.js';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../../shared/trusted-clock/index.js';
import { createUpdateLessonRecordUseCaseWithServices } from './update-lesson-record-use-case.js';
import type { UpdateLessonRecordServices } from './types.js';

export type LessonRecordTrustedClockFactory = (
  tx: Prisma.TransactionClient,
) => TrustedClock;

export type LessonRecordChangelogFactory = (
  tx: Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;

export interface CreateUpdateLessonRecordUseCaseOptions {
  rawPrisma: PrismaClient;
  trustedClockFactory?: LessonRecordTrustedClockFactory;
  changelogFactory?: LessonRecordChangelogFactory;
  /** P8 phase-3 批4：字段加密 cipher（透传给 LessonRecordEditor）。 */
  cipher?: FieldCipher;
}

class LessonRecordTransactionRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('lesson-record transaction rollback');
  }
}

export function createUpdateLessonRecordUseCase(
  options: CreateUpdateLessonRecordUseCaseOptions,
) {
  const trustedClockFactory = options.trustedClockFactory
    ?? ((tx: Prisma.TransactionClient) => createDatabaseTrustedClock(tx));
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx));

  const services: UpdateLessonRecordServices = {
    async transaction<T>(work: Parameters<UpdateLessonRecordServices['transaction']>[0]) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            lessons: createLessonRecordEditor({
              prisma: tx,
              trustedClock: trustedClockFactory(tx),
              cipher: options.cipher,
            }),
            changelog: changelogFactory(tx),
          });
          if (!result.ok) throw new LessonRecordTransactionRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof LessonRecordTransactionRollback) {
          return caught.result as Result<T, CommonError>;
        }
        throw caught;
      }
    },
  };

  return createUpdateLessonRecordUseCaseWithServices(services);
}

export { createUpdateLessonRecordUseCaseWithServices };
export type {
  EditReceipt,
  UpdateLessonRecordCommand,
  UpdateLessonRecordResult,
  UpdateLessonRecordServices,
  UpdateLessonRecordTransactionalServices,
  UpdateLessonRecordUseCase,
} from './types.js';
