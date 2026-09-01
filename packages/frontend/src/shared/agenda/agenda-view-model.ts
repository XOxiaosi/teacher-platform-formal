import type { AgendaItem } from '@teacher-platform/contracts';

export interface TodayAgendaGroups {
  lessons: AgendaItem[];
  pendingActions: AgendaItem[];
  memos: AgendaItem[];
  otherReminders: AgendaItem[];
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  planned: '计划中',
  completed: '已完成',
  cancelled: '已取消',
  missed: '未到',
  rescheduled: '已改期',
  extra: '临时加课',
  pending: '待确认',
  active: '待处理',
};

export function groupTodayAgenda(items: readonly AgendaItem[]): TodayAgendaGroups {
  const groups: TodayAgendaGroups = {
    lessons: [],
    pendingActions: [],
    memos: [],
    otherReminders: [],
  };
  const seenIds = new Set<string>();

  for (const item of items) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);

    if (item.kind === 'lesson') {
      groups.lessons.push(item);
    } else if (item.kind === 'pending_action') {
      groups.pendingActions.push(item);
    } else if (item.kind === 'memo') {
      groups.memos.push(item);
    } else if (
      item.kind === 'payment_reminder'
      || item.kind === 'feedback_followup'
      || item.kind === 'custom_reminder'
    ) {
      groups.otherReminders.push(item);
    } else {
      groups.otherReminders.push({ ...item, actions: [] });
    }
  }

  return groups;
}

export function agendaStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? '状态未知';
}

export function summarizeTodayAgenda(groups: TodayAgendaGroups): string {
  return `${groups.lessons.length}节课程，${groups.pendingActions.length}项待确认，${groups.memos.length}条到期备忘。`;
}
