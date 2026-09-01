import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createStudentProfileEditor } from '../../../features/students/index.js';
import {
  createChangelogService,
  type ChangelogService,
} from '../../../shared/changelog/index.js';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../../shared/trusted-clock/index.js';
import { createUpdateStudentProfileUseCaseWithServices } from './update-student-profile-use-case.js';
import type { UpdateStudentProfileServices } from './types.js';

export type StudentProfileTrustedClockFactory = (
  tx: Prisma.TransactionClient,
) => TrustedClock;

export type StudentProfileChangelogFactory = (
  tx: Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;

export interface CreateUpdateStudentProfileUseCaseOptions {
  rawPrisma: PrismaClient;
  trustedClockFactory?: StudentProfileTrustedClockFactory;
  changelogFactory?: StudentProfileChangelogFactory;
}

class StudentProfileTransactionRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('student-profile transaction rollback');
  }
}

export function createUpdateStudentProfileUseCase(
  options: CreateUpdateStudentProfileUseCaseOptions,
) {
  const trustedClockFactory = options.trustedClockFactory
    ?? ((tx: Prisma.TransactionClient) => createDatabaseTrustedClock(tx));
  const changelogFactory = options.changelogFactory
    ?? ((tx: Prisma.TransactionClient) => createChangelogService(tx));

  const services: UpdateStudentProfileServices = {
    async transaction<T>(work: Parameters<UpdateStudentProfileServices['transaction']>[0]) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            students: createStudentProfileEditor({
              prisma: tx,
              trustedClock: trustedClockFactory(tx),
            }),
            changelog: changelogFactory(tx),
          });
          if (!result.ok) throw new StudentProfileTransactionRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof StudentProfileTransactionRollback) {
          return caught.result as Result<T, CommonError>;
        }
        throw caught;
      }
    },
  };

  return createUpdateStudentProfileUseCaseWithServices(services);
}

export { createUpdateStudentProfileUseCaseWithServices };
export type {
  EditReceipt,
  UpdateStudentProfileCommand,
  UpdateStudentProfileResult,
  UpdateStudentProfileServices,
  UpdateStudentProfileTransactionalServices,
  UpdateStudentProfileUseCase,
} from './types.js';
