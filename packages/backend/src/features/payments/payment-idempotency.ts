import type { Payment } from '@prisma/client';
import { decryptFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';

export interface PaymentCreatePayload {
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: Date;
  note?: string | null;
}

/**
 * A request key names one immutable create intent.  Compare plaintext note
 * values because the stored note can be encrypted with a non-deterministic
 * cipher representation.
 */
export function matchesPaymentCreatePayload(
  payment: Pick<Payment, 'studentId' | 'amount' | 'lessonCount' | 'paidAtTs' | 'note'>,
  input: PaymentCreatePayload,
  cipher: FieldCipher | undefined,
): boolean {
  return payment.studentId === input.studentId
    && payment.amount === input.amount
    && payment.lessonCount === input.lessonCount
    && sameInstant(payment.paidAtTs, input.paidAt)
    && paymentNote(payment.note, cipher) === inputNote(input.note);
}

function sameInstant(left: Date, right: Date): boolean {
  const leftTime = left.getTime();
  const rightTime = right instanceof Date ? right.getTime() : Number.NaN;
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function inputNote(note: string | null | undefined): string | null {
  return note ?? null;
}

function paymentNote(note: string | null, cipher: FieldCipher | undefined): string | null {
  return note === null ? null : decryptFieldValue(cipher, note);
}
