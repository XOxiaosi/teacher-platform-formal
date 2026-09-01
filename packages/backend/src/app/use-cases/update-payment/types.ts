import type {
  CommonError,
  EditCommandMeta,
  Result,
} from '@teacher-platform/contracts';
import type {
  PaymentData,
  PaymentEditor,
} from '../../../features/payments/types.js';
import type { ChangelogService } from '../../../shared/changelog/index.js';

export interface UpdatePaymentChanges {
  amount?: number;
  lessonCount?: number;
  paidAt?: string;
  note?: string | null;
}

export interface UpdatePaymentCommand extends EditCommandMeta {
  paymentId: string;
  changes: UpdatePaymentChanges;
}

export interface EditReceipt<T> {
  value: T;
  changeLogId: string;
}

export type UpdatePaymentResult = EditReceipt<PaymentData>;

export interface UpdatePaymentUseCase {
  updatePayment(command: UpdatePaymentCommand): Promise<Result<UpdatePaymentResult, CommonError>>;
}

export interface UpdatePaymentTransactionalServices {
  payments: Pick<PaymentEditor, 'updatePayment'>;
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface UpdatePaymentServices {
  transaction<T>(
    work: (
      services: UpdatePaymentTransactionalServices,
    ) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}
