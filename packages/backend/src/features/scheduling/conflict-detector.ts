export interface TimeRange {
  start: Date;
  end: Date;
}

export interface ScheduleWithTime {
  id: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status?: string;
}

/** 不参与冲突检测的状态（已取消/已完成/缺席/已改期） */
const INACTIVE_STATUSES = new Set(['cancelled', 'completed', 'missed', 'rescheduled']);

/**
 * 检测新日程与已有日程的时间冲突。
 * 纯函数，无副作用。
 *
 * 冲突定义：时间区间有重叠（不含边界相接）。
 * 已取消/已完成/缺席/已改期的日程不参与冲突检测。
 *
 * 返回冲突的日程列表（不阻止创建，由调用方决定如何处理）。
 */
export function detectConflicts(
  newRange: TimeRange,
  existing: ScheduleWithTime[],
): ScheduleWithTime[] {
  return existing.filter((schedule) => {
    // 排除非活跃状态的日程
    if (schedule.status && INACTIVE_STATUSES.has(schedule.status)) {
      return false;
    }

    // 时间区间重叠检测：start1 < end2 && start2 < end1
    // 边界相接（start1 === end2）不算冲突
    return newRange.start < schedule.scheduledEnd && schedule.scheduledStart < newRange.end;
  });
}