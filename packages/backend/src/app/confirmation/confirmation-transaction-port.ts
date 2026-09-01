import type { CommonError, Result } from '@teacher-platform/contracts';
import { err, internalError } from '@teacher-platform/contracts';
import { createPendingActionExecutionStore } from '../../features/pending-action/index.js';
import { createDatabaseConfirmableActionRegistry } from './database-confirmable-action-registry.js';
import type {
  ConfirmationTransactionPort,
  CreateConfirmationTransactionPortOptions,
} from './types.js';

class ConfirmationRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('confirmation transaction rollback');
  }
}

export function createConfirmationTransactionPort(
  options: CreateConfirmationTransactionPortOptions,
): ConfirmationTransactionPort {
  const registryFactory = options.registryFactory ?? createDatabaseConfirmableActionRegistry;

  return {
    async run<T>(work: Parameters<ConfirmationTransactionPort['run']>[0]) {
      try {
        return await options.rawPrisma.$transaction(async (tx) => {
          const result = await work({
            pendingActions: createPendingActionExecutionStore(tx),
            registry: registryFactory(tx),
          });
          if (!result.ok) throw new ConfirmationRollback(result);
          return result as Result<T, CommonError>;
        });
      } catch (caught) {
        if (caught instanceof ConfirmationRollback) {
          return caught.result as Result<T, CommonError>;
        }
        return err(internalError('待确认操作执行失败'));
      }
    },
  };
}
