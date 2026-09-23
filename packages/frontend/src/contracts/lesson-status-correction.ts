export type CorrectionStatus = 'attended' | 'absent';

export type LessonStatusCorrectionPrepareRequest = {
  lessonId: string;
  targetStatus: CorrectionStatus;
  reason: string;
  clientRequestId: string;
};

export type LessonStatusCorrectionConfirmation = {
  id: string;
  status: string;
  lessonId: string;
  studentId: string;
  fromStatus: CorrectionStatus;
  toStatus: CorrectionStatus;
  reason: string;
  entry?: Record<string, unknown> | null;
};

export type LessonStatusCorrectionBalance = {
  purchased: number;
  attended: number;
  adjustments: number;
  remaining: number;
};

export type LessonStatusCorrectionPrepareResult = {
  confirmation: LessonStatusCorrectionConfirmation;
  balanceBefore: LessonStatusCorrectionBalance;
  balanceAfter: LessonStatusCorrectionBalance;
  plannedLedgerEntry?: Record<string, unknown> | null;
};

export type LessonStatusCorrectionConfirmResult = {
  confirmation: LessonStatusCorrectionConfirmation;
  lesson: { id: string; studentId: string; status: CorrectionStatus; updatedAt: string };
  balance: LessonStatusCorrectionBalance;
};
