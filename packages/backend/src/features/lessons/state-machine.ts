import type { Result, CommonError } from '@teacher-platform/contracts';
import { ok, err, validationError } from '@teacher-platform/contracts';

export type LessonStatus = 'pending' | 'attended' | 'absent';

const VALID_TRANSITIONS: Record<LessonStatus, LessonStatus[]> = {
  pending: ['attended', 'absent'],
  attended: ['absent'], // 回溯退还课时
  absent: ['attended'], // 回溯补扣课时
};

/**
 * 验证课次状态转换是否合法。
 * 纯函数，无副作用。
 *
 * 合法转换：
 *   pending -> attended（正常上课，扣课时）
 *   pending -> absent（请假，不扣课时）
 *   attended -> absent（回溯修改，退还课时）
 *   absent -> attended（回溯修改，补扣课时）
 */
export function validateLessonTransition(
  from: LessonStatus,
  to: LessonStatus,
): Result<true, CommonError> {
  if (from === to) {
    return err(validationError(`状态无变化：当前 ${from}，目标 ${to}`, 'status'));
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return err(validationError(
      `非法状态转换：${from} -> ${to}。${from} 的合法目标状态：${allowed.join(', ')}`,
      'status',
    ));
  }

  return ok(true);
}