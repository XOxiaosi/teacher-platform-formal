import { ok } from '@teacher-platform/contracts';
import type { CancelPendingActionUseCase, CreateCancelPendingActionUseCaseOptions } from './types.js';

export function createCancelPendingActionUseCase(
  options: CreateCancelPendingActionUseCaseOptions,
): CancelPendingActionUseCase {
  return {
    async cancel(input) {
      return options.transaction.run(async ({ pendingActions }) => {
        const databaseNow = await pendingActions.getDatabaseNow();
        if (!databaseNow.ok) return databaseNow;
        const cancelled = await pendingActions.cancel({
          pendingActionId: input.pendingActionId,
          teacherId: input.teacherId,
          databaseNow: databaseNow.value,
        });
        if (!cancelled.ok) return cancelled;
        return ok({ pendingAction: cancelled.value });
      });
    },
  };
}
