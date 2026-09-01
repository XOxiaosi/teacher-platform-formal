import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createMemoEditor } from '../../../features/memos/index.js';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';
import {
  createChangelogService,
  type ChangelogService,
} from '../../../shared/changelog/index.js';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../../shared/trusted-clock/index.js';
import { createUpdateMemoUseCaseWithServices } from './update-memo-use-case.js';
import type { UpdateMemoServices } from './types.js';

export type MemoTrustedClockFactory = (
  tx: Prisma.TransactionClient,
) => TrustedClock;

export type MemoChangelogFactory = (
  tx: Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;

export interface CreateUpdateMemoUseCaseOptions {
  rawPrisma: PrismaClient;
  trustedClockFactory?: MemoTrustedClockFactory;
  changelogFactory?: MemoChangelogFactory;
  /** P8 phase-3 批6：字段加密 cipher（透传给 MemoEditor）。 */
  cipher?: FieldCipher;
}

class MemoTransactionRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('memo transaction rollback');
  }
}

export function createUpdateMemoUseCase(
  options: CreateUpdateMemoUseCaseOptions,
) {
  const trustedClockFactory = options.trustedClockFactory
    ?? ((tx: Prisma.TransactionClient) => createDatabaseTrustedClock(tx));
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx));

  const services: UpdateMemoServices = {
    async transaction<T>(work: Parameters<UpdateMemoServices['transaction']>[0]) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            memos: createMemoEditor({
              prisma: tx,
              trustedClock: trustedClockFactory(tx),
              cipher: options.cipher,
            }),
            changelog: changelogFactory(tx),
          });
          if (!result.ok) throw new MemoTransactionRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof MemoTransactionRollback) {
          return caught.result as Result<T, CommonError>;
        }
        throw caught;
      }
    },
  };

  return createUpdateMemoUseCaseWithServices(services);
}

export { createUpdateMemoUseCaseWithServices };
export type {
  EditReceipt,
  UpdateMemoChanges,
  UpdateMemoCommand,
  UpdateMemoResult,
  UpdateMemoServices,
  UpdateMemoTransactionalServices,
  UpdateMemoUseCase,
} from './types.js';
