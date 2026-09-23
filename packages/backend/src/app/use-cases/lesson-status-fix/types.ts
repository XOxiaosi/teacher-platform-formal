import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { LessonLedgerEntryData } from '../../../features/payments/types.js';
import type { LessonData, LessonStatus } from '../../../features/lessons/index.js';

export type CorrectableLessonStatus = Extract<LessonStatus, 'attended' | 'absent'>;

export interface PrepareLessonStatusCorrectionInput {
  teacherId: string;
  lessonId: string;
  targetStatus: CorrectableLessonStatus;
  reason: string;
  clientRequestId: string;
}

export interface ConfirmLessonStatusCorrectionInput {
  teacherId: string;
  confirmationId: string;
}

export interface LessonBalance {
  purchased: number;
  attended: number;
  adjustments: number;
  remaining: number;
}

export interface LessonStatusCorrectionConfirmationData {
  id: string;
  teacherId: string;
  lessonId: string;
  studentId: string;
  fromStatus: CorrectableLessonStatus;
  toStatus: CorrectableLessonStatus;
  reason: string;
  clientRequestId: string;
  status: 'pending' | 'confirmed' | 'expired';
  expectedLessonUpdatedAt: Date;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  entry: LessonLedgerEntryData | null;
}

export interface PlannedLessonLedgerEntry {
  entryType: Extract<LessonLedgerEntryData['entryType'], 'attendance_deduction' | 'attendance_reversal'>;
  lessonDelta: -1 | 1;
}

export interface PreparedLessonStatusCorrectionData {
  confirmation: LessonStatusCorrectionConfirmationData;
  balanceBefore: LessonBalance;
  balanceAfter: LessonBalance;
  plannedLedgerEntry: PlannedLessonLedgerEntry | null;
}

export interface ConfirmedLessonStatusCorrectionData {
  confirmation: LessonStatusCorrectionConfirmationData;
  lesson: LessonData;
  balance: LessonBalance;
}

export interface LessonStatusFixUseCase {
  prepareLessonStatusCorrection(input: PrepareLessonStatusCorrectionInput): Promise<Result<PreparedLessonStatusCorrectionData, CommonError>>;
  confirmLessonStatusCorrection(input: ConfirmLessonStatusCorrectionInput): Promise<Result<ConfirmedLessonStatusCorrectionData, CommonError>>;
}

export type LessonStatusFixFactory = (prisma: PrismaClient) => LessonStatusFixUseCase;
