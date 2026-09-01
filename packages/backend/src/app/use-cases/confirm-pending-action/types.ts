import type { CommonError, Result } from '@teacher-platform/contracts';
import type { ActionTokenSigner } from '../../../features/pending-action/index.js';
import type {
  ConfirmationTransactionPort,
  ConfirmPendingActionInput,
  ConfirmPendingActionResult,
} from '../../confirmation/types.js';

export interface ConfirmPendingActionUseCase {
  confirm(input: ConfirmPendingActionInput): Promise<Result<ConfirmPendingActionResult, CommonError>>;
}

export interface CreateConfirmPendingActionUseCaseOptions {
  actionTokenSigner: ActionTokenSigner;
  transaction: ConfirmationTransactionPort;
}
