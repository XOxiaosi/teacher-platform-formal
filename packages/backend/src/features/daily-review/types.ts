import type { CommonError, PaginationParams, Result } from '@teacher-platform/contracts';

export interface CreateReviewInput {
  teacherId: string;
  date: Date;
  plannedCount: number;
  actualCount: number;
  cancelledCount: number;
  missedCount: number;
  rescheduledCount: number;
  pendingCount: number;
  deviations: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  tomorrowSuggestion?: string;
}

export interface GetReviewInput {
  teacherId: string;
  date: Date;
}

export interface ListReviewsInput extends PaginationParams {
  teacherId: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface StatusItem {
  id?: string;
  title?: string;
  status?: string;
  pendingFields?: string[];
}

export interface CalculateDeviationInput {
  plannedSchedules: StatusItem[];
  actualLessons: StatusItem[];
  memoTasks: StatusItem[];
}

export interface DeviationResult {
  plannedCount: number;
  actualCount: number;
  cancelledCount: number;
  missedCount: number;
  rescheduledCount: number;
  pendingCount: number;
  deviations: Record<string, unknown>[];
}

export interface GenerateTomorrowSuggestionInput {
  tomorrowSchedules: StatusItem[];
  pendingSchedules: StatusItem[];
  lowBalanceStudents: { name: string; remainingLessons: number }[];
}

export interface AppendCorrectionInput {
  teacherId: string;
  date: Date;
  correction: Record<string, unknown>;
}

export interface DailyReviewData extends CreateReviewInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DailyReviewService {
  createReview(input: CreateReviewInput): Promise<Result<DailyReviewData, CommonError>>;
  getReview(input: GetReviewInput): Promise<Result<DailyReviewData, CommonError>>;
  listReviews(input: ListReviewsInput): Promise<Result<{ items: DailyReviewData[]; total: number }, CommonError>>;
  calculateDeviation(input: CalculateDeviationInput): Result<DeviationResult, CommonError>;
  generateTomorrowSuggestion(input: GenerateTomorrowSuggestionInput): Result<string, CommonError>;
  appendCorrection(input: AppendCorrectionInput): Promise<Result<DailyReviewData, CommonError>>;
}
