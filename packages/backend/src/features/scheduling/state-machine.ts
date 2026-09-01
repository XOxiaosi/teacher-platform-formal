import type { Result, CommonError } from '@teacher-platform/contracts';
import { ok, err, validationError } from '@teacher-platform/contracts';

export type ScheduleStatus =
  | 'planned'
  | 'completed'
  | 'cancelled'
  | 'missed'
  | 'rescheduled'
  | 'extra';

/** 合法状态转换表 */
const VALID_TRANSITIONS: Record<ScheduleStatus, ScheduleStatus[]> = {
  planned: ['completed', 'cancelled', 'missed', 'rescheduled'],
  extra: ['completed'],
  completed: [],
  // D49: cancelled -> planned 为误删恢复路径（restore 前过冲突检查）
  cancelled: ['planned'],
  missed: [],
  rescheduled: [],
};

/**
 * 验证日程状态转换是否合法。
 * 纯函数，无副作用。
 *
 * 合法转换：
 *   planned -> completed / cancelled / missed / rescheduled
 *   extra -> completed
 *   cancelled -> planned（D49 误删恢复，restore 前过冲突检查）
 *   其他状态为终态，不可转换
 */
export function validateTransition(
  from: ScheduleStatus,
  to: ScheduleStatus,
): Result<true, CommonError> {
  if (from === to) {
    return err(validationError(
      `状态无变化：当前 ${from}，目标 ${to}`,
      'status',
    ));
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return err(validationError(
      `非法状态转换：${from} -> ${to}。${from} 的合法目标状态：${allowed.length > 0 ? allowed.join(', ') : '无（终态）'}`,
      'status',
    ));
  }

  return ok(true);
}