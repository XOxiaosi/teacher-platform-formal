import type { Result, CommonError, PaginationParams } from '@teacher-platform/contracts';

export interface CreatePaymentInput {
  teacherId: string;
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: Date;
  note?: string;
}

export interface ListPaymentsInput extends PaginationParams {
  teacherId: string;
  studentId?: string;
  paidAtFrom?: Date;
  paidAtTo?: Date;
}

export interface GetOwnedPaymentInput {
  teacherId: string;
  paymentId: string;
}

export interface UpdatePaymentInput {
  paymentId: string;
  amount?: number;
  lessonCount?: number;
  paidAt?: Date;
  note?: string;
}

export interface PaymentChanges {
  amount?: number;
  lessonCount?: number;
  paidAt?: Date;
  note?: string | null;
}

export interface UpdatePaymentOwnerInput {
  teacherId: string;
  paymentId: string;
  expectedUpdatedAt?: Date;
  changes: PaymentChanges;
}

export interface PaymentEdit {
  before: PaymentData;
  after: PaymentData;
}

export interface PaymentEditor {
  updatePayment(
    input: UpdatePaymentOwnerInput,
  ): Promise<Result<PaymentEdit, CommonError>>;
}

export interface SumLessonCountInput {
  studentId: string;
}

export interface PaymentData {
  id: string;
  teacherId: string;
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: Date;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LessonLedgerEntryType =
  | 'purchase'
  | 'attendance_deduction'
  | 'attendance_reversal'
  | 'refund'
  | 'gift'
  | 'manual_adjustment';

export interface LessonLedgerEntryData {
  id: string;
  teacherId: string;
  studentId: string;
  entryType: LessonLedgerEntryType;
  lessonDelta: number;
  amount: number | null;
  reason: string | null;
  paymentId: string | null;
  lessonId: string | null;
  adjustmentConfirmationId: string | null;
  clientRequestId: string | null;
  createdAt: Date;
}

export interface LessonLedgerBalance {
  /** 历史兼容字段：购课流水的正课时，不含赠课/人工调整。 */
  purchased: number;
  /** 历史兼容字段：已扣除的出勤课时。 */
  attended: number;
  /** 退款、赠课、人工调整的净课时变化。 */
  adjustments: number;
  /** 唯一权威余额：全部不可变流水之和。 */
  remaining: number;
}

export interface CreateLedgerAdjustmentInput {
  teacherId: string;
  studentId: string;
  entryType: Extract<LessonLedgerEntryType, 'refund' | 'gift' | 'manual_adjustment'>;
  lessonDelta: number;
  reason: string;
  clientRequestId: string;
}

export interface LedgerAdjustmentConfirmationData {
  id: string;
  teacherId: string;
  studentId: string;
  entryType: Extract<LessonLedgerEntryType, 'refund' | 'gift' | 'manual_adjustment'>;
  lessonDelta: number;
  reason: string;
  clientRequestId: string;
  status: 'pending' | 'confirmed' | 'expired';
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  entry: LessonLedgerEntryData | null;
}

export interface ConfirmLedgerAdjustmentInput {
  teacherId: string;
  confirmationId: string;
}

export interface RecordAttendanceDeductionInput {
  teacherId: string;
  lessonId: string;
}

/** Must run in the same transaction as the status CAS update. */
export interface RecordLessonStatusTransitionInput {
  teacherId: string;
  lessonId: string;
  fromStatus: 'attended' | 'absent';
  toStatus: 'attended' | 'absent';
}

export interface RecordPurchaseLedgerInput {
  teacherId: string;
  studentId: string;
  paymentId: string;
  lessonCount: number;
  amount: number;
}

export interface LessonLedgerService {
  listEntries(input: { teacherId: string; studentId?: string; from?: Date; to?: Date }): Promise<Result<LessonLedgerEntryData[], CommonError>>;
  recordPurchase(input: RecordPurchaseLedgerInput): Promise<Result<LessonLedgerEntryData, CommonError>>;
  recordAttendanceDeduction(input: RecordAttendanceDeductionInput): Promise<Result<LessonLedgerEntryData | null, CommonError>>;
  recordLessonStatusTransition(input: RecordLessonStatusTransitionInput): Promise<Result<LessonLedgerEntryData | null, CommonError>>;
  prepareAdjustment(input: CreateLedgerAdjustmentInput): Promise<Result<LedgerAdjustmentConfirmationData, CommonError>>;
  confirmAdjustment(input: ConfirmLedgerAdjustmentInput): Promise<Result<LedgerAdjustmentConfirmationData, CommonError>>;
  calculateBalance(input: { teacherId: string; studentId: string }): Promise<Result<LessonLedgerBalance, CommonError>>;
}

export interface PaymentService {
  createPayment(input: CreatePaymentInput): Promise<Result<PaymentData, CommonError>>;
  getPayment(paymentId: string): Promise<Result<PaymentData, CommonError>>;
  getOwnedPayment(input: GetOwnedPaymentInput): Promise<Result<PaymentData, CommonError>>;
  listPayments(input: ListPaymentsInput): Promise<Result<{ items: PaymentData[]; total: number }, CommonError>>;
  updatePayment(input: UpdatePaymentInput): Promise<Result<PaymentData, CommonError>>;
  sumLessonCount(input: SumLessonCountInput): Promise<Result<number, CommonError>>;
}
