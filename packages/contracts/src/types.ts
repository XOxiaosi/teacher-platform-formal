/**
 * 通用类型定义
 * 所有模块共享的类型约定，定义在 contracts 层
 */

// ---- Result 类型 ----

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error: error });

// ---- 通用错误类型 ----

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
  field?: string;
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

// ---- 通用响应格式（API 层使用） ----

export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

export interface ListSuccessResponse<T> {
  ok: true;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export interface ErrorResponse {
  ok: false;
  error: CommonError;
}

// ---- 分页请求参数 ----

export interface PaginationParams {
  page?: number; // 从 1 开始
  pageSize?: number; // 默认 20
}

export interface SortParams {
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}