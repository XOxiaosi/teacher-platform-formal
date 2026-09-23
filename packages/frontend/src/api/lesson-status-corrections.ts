import { apiRequest } from './client';
import type {
  LessonStatusCorrectionConfirmResult,
  LessonStatusCorrectionPrepareRequest,
  LessonStatusCorrectionPrepareResult,
} from '../contracts/lesson-status-correction';

export type {
  CorrectionStatus,
  LessonStatusCorrectionBalance,
  LessonStatusCorrectionConfirmation,
  LessonStatusCorrectionConfirmResult,
  LessonStatusCorrectionPrepareRequest,
  LessonStatusCorrectionPrepareResult,
} from '../contracts/lesson-status-correction';

export function prepareLessonStatusCorrection(body: LessonStatusCorrectionPrepareRequest) {
  return apiRequest<LessonStatusCorrectionPrepareResult>('/lesson-status-corrections', { method: 'POST', body });
}

export function confirmLessonStatusCorrection(confirmationId: string) {
  return apiRequest<LessonStatusCorrectionConfirmResult>(`/lesson-status-corrections/${encodeURIComponent(confirmationId)}/confirm`, { method: 'POST' });
}
