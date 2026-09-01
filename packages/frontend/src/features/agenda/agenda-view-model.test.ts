import { describe, expect, it } from 'vitest';
import type { AgendaItem, ObjectReference } from '@teacher-platform/contracts';

interface TodayAgendaGroups {
  lessons: AgendaItem[];
  pendingActions: AgendaItem[];
  memos: AgendaItem[];
  otherReminders: AgendaItem[];
}

interface AgendaViewModelModule {
  groupTodayAgenda?: (items: readonly AgendaItem[]) => TodayAgendaGroups;
  agendaStatusLabel?: (status: string) => string;
  summarizeTodayAgenda?: (groups: TodayAgendaGroups) => string;
}

const scheduleReference: ObjectReference = {
  id: 'Schedule:schedule-1',
  type: 'Schedule',
  objectId: 'schedule-1',
  label: '课程',
};

function item(overrides: Partial<AgendaItem> & Pick<AgendaItem, 'id' | 'kind' | 'title'>): AgendaItem {
  const { id, kind, title, ...optional } = overrides;
  return {
    id,
    kind,
    title,
    allDay: kind !== 'lesson',
    status: 'active',
    sourceRef: scheduleReference,
    actions: [],
    ...optional,
  };
}

async function loadViewModel(): Promise<Required<AgendaViewModelModule> | undefined> {
  let module: AgendaViewModelModule = {};
  try {
    const modulePath = './agenda-view-model';
    module = await import(/* @vite-ignore */ modulePath) as unknown as AgendaViewModelModule;
  } catch {
    module = {};
  }
  expect(module).toMatchObject({
    groupTodayAgenda: expect.any(Function),
    agendaStatusLabel: expect.any(Function),
    summarizeTodayAgenda: expect.any(Function),
  });
  if (!module.groupTodayAgenda || !module.agendaStatusLabel || !module.summarizeTodayAgenda) {
    return undefined;
  }
  return module as Required<AgendaViewModelModule>;
}

describe('Agenda Today view model', () => {
  it('按kind稳定分组并按item id去重，不读取时间重新排序', async () => {
    const viewModel = await loadViewModel();
    if (!viewModel) return;
    const lesson = item({ id: 'schedule:1', kind: 'lesson', title: '第一节课', status: 'planned' });
    const groups = viewModel.groupTodayAgenda([
      lesson,
      item({ id: 'pending-action:1', kind: 'pending_action', title: '待确认', status: 'pending' }),
      lesson,
      item({ id: 'memo:2', kind: 'memo', title: '第二条备忘' }),
      item({ id: 'memo:1', kind: 'memo', title: '第一条备忘' }),
      item({ id: 'payment:1', kind: 'payment_reminder', title: '收费提醒' }),
    ]);

    expect(groups.lessons.map(({ id }) => id)).toEqual(['schedule:1']);
    expect(groups.pendingActions.map(({ id }) => id)).toEqual(['pending-action:1']);
    expect(groups.memos.map(({ id }) => id)).toEqual(['memo:2', 'memo:1']);
    expect(groups.otherReminders.map(({ id }) => id)).toEqual(['payment:1']);
  });

  it('未来Reminder进入其他提醒，运行时未知kind安全清空actions', async () => {
    const viewModel = await loadViewModel();
    if (!viewModel) return;
    const unknown = {
      ...item({
        id: 'unknown:1',
        kind: 'custom_reminder',
        title: '未知提醒',
        actions: [{ id: 'unsafe', kind: 'open-reference', label: '打开', referenceId: scheduleReference.id }],
      }),
      kind: 'runtime_unknown',
    } as unknown as AgendaItem;

    const groups = viewModel.groupTodayAgenda([
      item({ id: 'feedback:1', kind: 'feedback_followup', title: '反馈跟进' }),
      item({ id: 'custom:1', kind: 'custom_reminder', title: '自定义提醒' }),
      unknown as AgendaItem,
    ]);

    expect(groups.otherReminders.map(({ id }) => id)).toEqual(['feedback:1', 'custom:1', 'unknown:1']);
    expect(groups.otherReminders[2]?.actions).toEqual([]);
  });

  it('已知状态中文化，未知状态不直接暴露内部字符串', async () => {
    const viewModel = await loadViewModel();
    if (!viewModel) return;

    expect(viewModel.agendaStatusLabel('planned')).toBe('计划中');
    expect(viewModel.agendaStatusLabel('completed')).toBe('已完成');
    expect(viewModel.agendaStatusLabel('cancelled')).toBe('已取消');
    expect(viewModel.agendaStatusLabel('missed')).toBe('未到');
    expect(viewModel.agendaStatusLabel('rescheduled')).toBe('已改期');
    expect(viewModel.agendaStatusLabel('extra')).toBe('临时加课');
    expect(viewModel.agendaStatusLabel('pending')).toBe('待确认');
    expect(viewModel.agendaStatusLabel('active')).toBe('待处理');
    expect(viewModel.agendaStatusLabel('database_internal_state')).toBe('状态未知');
  });

  it('摘要只使用可信文档分组数量', async () => {
    const viewModel = await loadViewModel();
    if (!viewModel) return;
    const groups = viewModel.groupTodayAgenda([
      item({ id: 'schedule:1', kind: 'lesson', title: '课程1' }),
      item({ id: 'schedule:2', kind: 'lesson', title: '课程2' }),
      item({ id: 'pending:1', kind: 'pending_action', title: '待确认' }),
      item({ id: 'memo:1', kind: 'memo', title: '备忘1' }),
      item({ id: 'memo:2', kind: 'memo', title: '备忘2' }),
    ]);

    expect(viewModel.summarizeTodayAgenda(groups)).toBe('2节课程，1项待确认，2条到期备忘。');
  });
});
