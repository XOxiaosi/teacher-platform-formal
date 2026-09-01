import type { Result, CommonError } from '@teacher-platform/contracts';
import { ok, err, validationError } from '@teacher-platform/contracts';

export type StudentStatus = 'active' | 'paused' | 'finished';

const VALID_TRANSITIONS: Record<StudentStatus, StudentStatus[]> = {
  active: ['paused', 'finished'],
  paused: ['active', 'finished'],
  finished: [],
};

/**
 * 验证学生状态转换是否合法。
 * 纯函数，无副作用。
 *
 * 合法转换：
 *   active -> paused / finished
 *   paused -> active / finished
 *   finished 为终态，不可转换
 */
export function validateStudentTransition(
  from: StudentStatus,
  to: StudentStatus,
): Result<true, CommonError> {
  if (from === to) {
    return err(validationError(
      `状态无变化：当前 ${from}，目标 ${to}`,
      'currentStatus',
    ));
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return err(validationError(
      `非法状态转换：${from} -> ${to}。${from} 的合法目标状态：${allowed.length > 0 ? allowed.join(', ') : '无（终态）'}`,
      'currentStatus',
    ));
  }

  return ok(true);
}