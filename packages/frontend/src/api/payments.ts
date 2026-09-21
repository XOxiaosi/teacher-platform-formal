import { apiRequest } from './client';
import type {
  EditReceipt,
  EditRequest,
  ListResult,
  PaymentChanges,
  PaymentData,
  LessonLedgerEntryData,
} from './types';

export interface CreatePaymentRequest {
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: string;
  note?: string;
}

export function listLessonLedgerEntries(teacherId: string, params: { studentId?: string } = {}): Promise<LessonLedgerEntryData[]> {
  const query = params.studentId ? `?studentId=${encodeURIComponent(params.studentId)}` : '';
  return apiRequest(`/lesson-ledger/entries${query}`, { teacherId });
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
