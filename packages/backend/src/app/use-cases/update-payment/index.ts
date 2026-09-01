import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createPaymentEditor } from '../../../features/payments/index.js';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';
import {
  createChangelogService,
  type ChangelogService,
} from '../../../shared/changelog/index.js';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../../shared/trusted-clock/index.js';
import { createUpdatePaymentUseCaseWithServices } from './update-payment-use-case.js';
import type { UpdatePaymentServices } from './types.js';

export type PaymentTrustedClockFactory = (
  tx: Prisma.TransactionClient,
) => TrustedClock;

export type PaymentChangelogFactory = (
  tx: Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;

export interface CreateUpdatePaymentUseCaseOptions {
  rawPrisma: PrismaClient;
  trustedClockFactory?: PaymentTrustedClockFactory;
  changelogFactory?: PaymentChangelogFactory;
  /** P8 phase-3 批6：字段加密 cipher（透传给 PaymentEditor）。 */
  cipher?: FieldCipher;
}

class PaymentTransactionRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('payment transaction rollback');
  }
}

export function createUpdatePaymentUseCase(
  options: CreateUpdatePaymentUseCaseOptions,
) {
  const trustedClockFactory = options.trustedClockFactory
    ?? ((tx: Prisma.TransactionClient) => createDatabaseTrustedClock(tx));
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx));

  const services: UpdatePaymentServices = {
    async transaction<T>(work: Parameters<UpdatePaymentServices['transaction']>[0]) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            payments: createPaymentEditor({
              prisma: tx,
              trustedClock: trustedClockFactory(tx),
              cipher: options.cipher,
            }),
            changelog: changelogFactory(tx),
          });
          if (!result.ok) throw new PaymentTransactionRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof PaymentTransactionRollback) {
          return caught.result as Result<T, CommonError>;
        }
        throw caught;
      }
    },
  };

  return createUpdatePaymentUseCaseWithServices(services);
}

export { createUpdatePaymentUseCaseWithServices };
export type {
  EditReceipt,
  UpdatePaymentChanges,
  UpdatePaymentCommand,
  UpdatePaymentResult,
  UpdatePaymentServices,
  UpdatePaymentTransactionalServices,
  UpdatePaymentUseCase,
} from './types.js';
