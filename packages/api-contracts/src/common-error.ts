export type CommonErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'ALREADY_CONSUMED'
  | 'VERSION_CONFLICT'
  | 'INTERNAL_ERROR'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED';

export interface CommonError {
  code: CommonErrorCode;
  message: string;
  field?: string | undefined;
}

export const notFound = (message: string): CommonError => ({
  code: 'NOT_FOUND',
  message,
});

export const validationError = (message: string, field?: string): CommonError => ({
  code: 'VALIDATION_ERROR',
  message,
  field,
});

export const permissionDenied = (message: string): CommonError => ({
  code: 'PERMISSION_DENIED',
  message,
});

export const alreadyConsumed = (message: string): CommonError => ({
  code: 'ALREADY_CONSUMED',
  message,
});

export const versionConflict = (): CommonError => ({
  code: 'VERSION_CONFLICT',
  message: '记录已被其他操作更新，请刷新后重试',
  field: 'expectedUpdatedAt',
});

export const internalError = (message: string): CommonError => ({
  code: 'INTERNAL_ERROR',
  message,
});

export const rateLimited = (message: string): CommonError => ({
  code: 'RATE_LIMITED',
  message,
  field: 'rate',
});

export const budgetExceeded = (message: string): CommonError => ({
  code: 'BUDGET_EXCEEDED',
  message,
  field: 'budget',
});
