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

export interface PaymentService {
  createPayment(input: CreatePaymentInput): Promise<Result<PaymentData, CommonError>>;
  getPayment(paymentId: string): Promise<Result<PaymentData, CommonError>>;
  getOwnedPayment(input: GetOwnedPaymentInput): Promise<Result<PaymentData, CommonError>>;
  listPayments(input: ListPaymentsInput): Promise<Result<{ items: PaymentData[]; total: number }, CommonError>>;
  updatePayment(input: UpdatePaymentInput): Promise<Result<PaymentData, CommonError>>;
  sumLessonCount(input: SumLessonCountInput): Promise<Result<number, CommonError>>;
}
