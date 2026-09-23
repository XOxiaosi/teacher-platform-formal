import { apiRequest } from './client';
import type {
  EditReceipt,
  EditRequest,
  ListResult,
  PaymentChanges,
  PaymentData,
  LessonLedgerEntryData,
  LessonLedgerAdjustmentEntryType,
  PrepareLessonLedgerAdjustmentRequest,
  PrepareLessonLedgerAdjustmentResult,
  ConfirmLessonLedgerAdjustmentResult,
} from './types';

export interface CreatePaymentRequest {
  clientRequestId: string;
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: string;
  note?: string;
}

export type { PrepareLessonLedgerAdjustmentRequest } from './types';

export function listLessonLedgerEntries(teacherId: string, params: { studentId?: string } = {}): Promise<LessonLedgerEntryData[]> {
  const query = params.studentId ? `?studentId=${encodeURIComponent(params.studentId)}` : '';
  return apiRequest(`/lesson-ledger/entries${query}`, { teacherId });
}

export function prepareLessonLedgerAdjustment(
  teacherId: string,
  body: PrepareLessonLedgerAdjustmentRequest,
): Promise<PrepareLessonLedgerAdjustmentResult> {
  return apiRequest('/lesson-ledger/adjustments', { method: 'POST', teacherId, body });
}

export function confirmLessonLedgerAdjustment(
  teacherId: string,
  confirmationId: string,
): Promise<ConfirmLessonLedgerAdjustmentResult> {
  return apiRequest(`/lesson-ledger/adjustments/${encodeURIComponent(confirmationId)}/confirm`, {
    method: 'POST',
    teacherId,
  });
}

export function listPayments(teacherId: string): Promise<ListResult<PaymentData>> {
  return apiRequest('/payments', { teacherId });
}

export function createPayment(teacherId: string, body: CreatePaymentRequest): Promise<PaymentData> {
  return apiRequest('/payments', { method: 'POST', teacherId, body });
}

export function updatePayment(
  teacherId: string,
  paymentId: string,
  body: EditRequest<PaymentChanges>,
): Promise<EditReceipt<PaymentData>> {
  return apiRequest(`/payments/${encodeURIComponent(paymentId)}`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}
