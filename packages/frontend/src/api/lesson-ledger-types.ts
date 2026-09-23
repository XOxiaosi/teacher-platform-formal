export interface LessonBalance {
  purchased: number;
  attended: number;
  adjustments: number;
  remaining: number;
}

export interface LessonLedgerEntryData {
  id: string;
  teacherId: string;
  studentId: string;
  entryType:
    | 'purchase'
    | 'attendance_deduction'
    | 'attendance_reversal'
    | 'refund'
    | 'gift'
    | 'manual_adjustment';
  lessonDelta: number;
  amount: number | null;
  reason: string | null;
  paymentId: string | null;
  lessonId: string | null;
  adjustmentConfirmationId: string | null;
  clientRequestId: string | null;
  createdAt: string;
}

export type LessonLedgerAdjustmentEntryType = 'gift' | 'refund' | 'manual_adjustment';

export interface PrepareLessonLedgerAdjustmentRequest {
  studentId: string;
  entryType: LessonLedgerAdjustmentEntryType;
  lessonDelta: number;
  reason: string;
  clientRequestId: string;
}

/** A two-step request. Pending is only a proposal; a replay may already be confirmed. */
export interface LessonLedgerAdjustmentConfirmationData {
  id: string;
  teacherId: string;
  studentId: string;
  entryType: LessonLedgerAdjustmentEntryType;
  lessonDelta: number;
  reason: string;
  clientRequestId: string;
  status: 'pending' | 'confirmed' | 'expired';
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  entry: LessonLedgerEntryData | null;
}

export interface PrepareLessonLedgerAdjustmentResult {
  confirmation: LessonLedgerAdjustmentConfirmationData;
  balanceBefore: LessonBalance;
  balanceAfter: LessonBalance;
}

export interface ConfirmLessonLedgerAdjustmentResult {
  confirmation: LessonLedgerAdjustmentConfirmationData;
  balance: LessonBalance;
}
