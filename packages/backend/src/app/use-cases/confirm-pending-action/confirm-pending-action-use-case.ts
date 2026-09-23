import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
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
        async ({ pendingActions, registry, paymentReceipts }) => {
          // 先按 teacher 读取状态。仅已消费的 payments.create 才能重建既有成功回执；
          // 其他动作、取消/过期/执行中状态仍走原 claim 状态机，不能因此放宽。
          const existing = await pendingActions.getOwned({
            pendingActionId: input.pendingActionId,
            teacherId: input.teacherId,
          });
          if (!existing.ok) return existing;
          if (existing.value.status === 'consumed' && existing.value.actionName === 'payments.create') {
            const receipt = await paymentReceipts.findPaymentCreateReceipt({
              teacherId: input.teacherId,
              pendingActionId: existing.value.id,
            });
            if (!receipt) return err(internalError('待确认操作执行失败'));
            return ok({
              kind: 'confirmed',
              value: { pendingAction: existing.value, result: receipt },
            });
          }

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
            pendingActionId: claimed.id,
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
