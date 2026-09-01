import type { CommonError, Result } from '@teacher-platform/contracts';
import type {
  CancelPendingActionInput,
  CancelPendingActionResult,
  ConfirmationTransactionPort,
} from '../../confirmation/types.js';

export interface CancelPendingActionUseCase {
  cancel(input: CancelPendingActionInput): Promise<Result<CancelPendingActionResult, CommonError>>;
}

export interface CreateCancelPendingActionUseCaseOptions {
  transaction: ConfirmationTransactionPort;
}
