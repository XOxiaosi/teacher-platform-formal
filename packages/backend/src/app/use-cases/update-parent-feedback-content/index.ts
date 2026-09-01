import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createParentFeedbackContentEditor } from '../../../features/feedback/index.js';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';
import {
  createChangelogService,
  type ChangelogService,
} from '../../../shared/changelog/index.js';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../../shared/trusted-clock/index.js';
import { createUpdateParentFeedbackContentUseCaseWithServices } from './update-parent-feedback-content-use-case.js';
import type { UpdateParentFeedbackContentServices } from './types.js';

export type ParentFeedbackTrustedClockFactory = (
  tx: Prisma.TransactionClient,
) => TrustedClock;

export type ParentFeedbackChangelogFactory = (
  tx: Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;

export interface CreateUpdateParentFeedbackContentUseCaseOptions {
  rawPrisma: PrismaClient;
  trustedClockFactory?: ParentFeedbackTrustedClockFactory;
  changelogFactory?: ParentFeedbackChangelogFactory;
  /** P8 phase-3 批1：字段加密 cipher（透传给 ParentFeedbackContentEditor）。 */
  cipher?: FieldCipher;
}

class ParentFeedbackTransactionRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('parent feedback transaction rollback');
  }
}

export function createUpdateParentFeedbackContentUseCase(
  options: CreateUpdateParentFeedbackContentUseCaseOptions,
) {
  const trustedClockFactory = options.trustedClockFactory
    ?? ((tx: Prisma.TransactionClient) => createDatabaseTrustedClock(tx));
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx));

  const services: UpdateParentFeedbackContentServices = {
    async transaction<T>(
      work: Parameters<UpdateParentFeedbackContentServices['transaction']>[0],
    ) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            feedback: createParentFeedbackContentEditor({
              prisma: tx,
              trustedClock: trustedClockFactory(tx),
              cipher: options.cipher,
            }),
            changelog: changelogFactory(tx),
          });
          if (!result.ok) throw new ParentFeedbackTransactionRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof ParentFeedbackTransactionRollback) {
          return caught.result as Result<T, CommonError>;
        }
        throw caught;
      }
    },
  };

  return createUpdateParentFeedbackContentUseCaseWithServices(services);
}

export { createUpdateParentFeedbackContentUseCaseWithServices };
export type {
  EditReceipt,
  UpdateParentFeedbackContentChanges,
  UpdateParentFeedbackContentCommand,
  UpdateParentFeedbackContentResult,
  UpdateParentFeedbackContentServices,
  UpdateParentFeedbackContentTransactionalServices,
  UpdateParentFeedbackContentUseCase,
} from './types.js';
