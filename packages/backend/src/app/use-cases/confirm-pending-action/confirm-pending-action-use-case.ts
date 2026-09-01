import { err, ok, validationError } from '@teacher-platform/contracts';
import type { ConfirmPendingActionResult } from '../../confirmation/types.js';
import type { CreateConfirmPendingActionUseCaseOptions, ConfirmPendingActionUseCase } from './types.js';

type ConfirmTransactionOutcome =
  | { kind: 'confirmed'; value: ConfirmPendingActionResult }
  | { kind: 'expired' };

export function createConfirmPendingActionUseCase(
  options: CreateConfirmPendingActionUseCaseOptions,
): ConfirmPendingActionUseCase {
  return {
    async confirm(input) {
      const verified = options.actionTokenSigner.verify(input.actionToken);
      if (!verified.ok) return verified;
      if (verified.value.pendingActionId !== input.pendingActionId) {
        return err(validationError('actionToken 与待确认操作不匹配', 'actionToken'));
      }

      const transactionResult = await options.transaction.run<ConfirmTransactionOutcome>(
        async ({ pendingActions, registry }) => {
          const databaseNow = await pendingActions.getDatabaseNow();
          if (!databaseNow.ok) return databaseNow;

          const claim = await pendingActions.claim({
            pendingActionId: input.pendingActionId,
            teacherId: input.teacherId,
            databaseNow: databaseNow.value,
          });
          if (!claim.ok) return claim;
          if (claim.value.kind === 'expired') return ok({ kind: 'expired' });
          const claimed = claim.value.pendingAction;

          const executor = registry.get(claimed.actionName);
          if (!executor.ok) return executor;
          const executed = await executor.value.execute({
            teacherId: claimed.teacherId,
            target: { type: claimed.targetType, id: claimed.targetId },
            parameters: claimed.parameters,
          });
          if (!executed.ok) return executed;

          const consumed = await pendingActions.markConsumed({
            pendingActionId: claimed.id,
            teacherId: claimed.teacherId,
            databaseNow: databaseNow.value,
          });
          if (!consumed.ok) return consumed;

          return ok({
            kind: 'confirmed',
            value: { pendingAction: consumed.value, result: executed.value },
          });
        },
      );
      if (!transactionResult.ok) return transactionResult;
      if (transactionResult.value.kind === 'expired') {
        return err(validationError('待确认操作已过期', 'pendingActionId'));
      }
      return ok(transactionResult.value.value);
    },
  };
}
