import { apiRequest } from './client';
import type { DailyReviewResult } from './types';

export interface AssembleDailyReviewRequest {
  date?: string;
}

export function assembleDailyReview(teacherId: string, body: AssembleDailyReviewRequest): Promise<DailyReviewResult> {
  return apiRequest('/daily-review/assemble', { method: 'POST', teacherId, body });
}
