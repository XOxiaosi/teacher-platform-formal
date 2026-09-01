import type { Result, CommonError } from '@teacher-platform/contracts';
import { ok, err, validationError } from '@teacher-platform/contracts';

export type StudentRecordReviewStatus =
  | 'candidate'
  | 'confirmed'
  | 'rejected'
  | 'superseded';

/** 合法状态转换表 */
const VALID_TRANSITIONS: Record<StudentRecordReviewStatus, StudentRecordReviewStatus[]> = {
  candidate: ['confirmed', 'rejected'],
  confirmed: ['rejected'],
  rejected: ['confirmed'],
  superseded: [],
};

/**
 * 验证学生记录审核状态转换是否合法。
 * 纯函数，无副作用。
 *
 * 合法转换：
 *   candidate -> confirmed / rejected
 *   confirmed -> rejected
 *   rejected  -> confirmed
 *   superseded 为终态，不可转换
 */
export function validateStudentRecordReviewTransition(
  from: string,
  to: string,
): Result<void, CommonError> {
  const allowed = VALID_TRANSITIONS[from as StudentRecordReviewStatus];
  if (!allowed || !allowed.includes(to as StudentRecordReviewStatus)) {
    return err(validationError('非法状态流转', 'reviewStatus'));
  }
  return ok(undefined);
}
