import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoData, type DemoData } from './data';
import type { PreviewActions } from './PreviewApp';
import { ScheduleDetails } from './ScheduleDetails';

afterEach(cleanup);

function setup(data: DemoData) {
  let opened: ReactNode = null;
  const open = vi.fn((_title: string, body: ReactNode) => { opened = body; });
  const prepare = vi.fn().mockResolvedValue({
    confirmation: { id: 'confirmation-1', status: 'prepared', lessonId: 'lesson-1', studentId: 's1', fromStatus: 'attended', toStatus: 'absent', reason: '签到复核', },
    balanceBefore: { purchased: 10, attended: 3, adjustments: 0, remaining: 7 },
    balanceAfter: { purchased: 10, attended: 2, adjustments: 0, remaining: 8 },
    plannedLedgerEntry: null,
  });
  const confirm = vi.fn().mockResolvedValue({ id: 'confirmation-1' });
  const actions: PreviewActions = {
    connected: true, data, setData: vi.fn(), ui: {}, setUi: vi.fn(), open, toast: vi.fn(), close: vi.fn(),
    complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), editCompletedSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), endRuleBefore: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(),
    prepareLessonStatusCorrection: prepare, confirmLessonStatusCorrection: confirm,
  };
  return { actions, open, prepare, confirm, body: () => opened };
}

describe('已完成课程出勤状态更正', () => {
  it('逐学生展示入口，原因必填，准备预览后取消不确认', async () => {
    const base = createDemoData();
    const data = { ...base, schedules: [{ ...base.schedules[0], attendance: [{ lessonId: 'lesson-1', studentId: 's1', status: 'attended' as const, updatedAt: 'v1' }] }] };
    const { actions, open, prepare, confirm, body } = setup(data);
    render(<ScheduleDetails actions={actions} item={data.schedules[0]} />);
    expect(screen.getByRole('button', { name: '更正李雨桐的出勤状态' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更正李雨桐的出勤状态' }));
    render(<>{body()}</>);
    expect(screen.getByText('李雨桐：已出勤 → 缺席')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看影响预览' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('更正原因（必填）'), { target: { value: '签到复核' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响预览' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ lessonId: 'lesson-1', targetStatus: 'absent', reason: '签到复核', clientRequestId: expect.any(String) }));
    render(<>{body()}</>);
    expect(screen.getByText(/当前只是预览，尚未生效/)).toBeInTheDocument();
    expect(screen.getByText('7 → 8（+1）')).toBeInTheDocument();
    expect(screen.getByText('改为缺席后，本次不再计入已用课时，预计返还 1 课时。')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '取消' }).at(-1)!);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('确认预览后调用确认动作，待确认和预览模式没有入口', () => {
    const base = createDemoData();
    const pending = { ...base.schedules[0], attendance: [{ lessonId: 'lesson-pending', studentId: 's1', status: 'pending' as const, updatedAt: 'v1' }] };
    const pendingSetup = setup({ ...base, schedules: [pending] });
    render(<ScheduleDetails actions={pendingSetup.actions} item={pending} />);
    expect(screen.queryByRole('button', { name: /更正.*的出勤状态/ })).not.toBeInTheDocument();

    const completed = { ...base.schedules[0], attendance: [{ lessonId: 'lesson-1', studentId: 's1', status: 'attended' as const, updatedAt: 'v1' }] };
    const previewSetup = setup({ ...base, schedules: [completed] });
    render(<ScheduleDetails actions={{ ...previewSetup.actions, connected: false }} item={completed} />);
    expect(screen.queryByRole('button', { name: /更正.*的出勤状态/ })).not.toBeInTheDocument();
  });

  it('确认预览调用 confirmation id，由 connected action 负责刷新工作区', async () => {
    const base = createDemoData();
    const completed = { ...base.schedules[0], attendance: [{ lessonId: 'lesson-1', studentId: 's1', status: 'attended' as const, updatedAt: 'v1' }] };
    const { actions, open, confirm, body } = setup({ ...base, schedules: [completed] });
    render(<ScheduleDetails actions={actions} item={completed} />);
    fireEvent.click(screen.getByRole('button', { name: '更正李雨桐的出勤状态' }));
    render(<>{body()}</>);
    fireEvent.change(screen.getByLabelText('更正原因（必填）'), { target: { value: '签到复核' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响预览' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    render(<>{body()}</>);
    fireEvent.click(screen.getByRole('button', { name: '确认更正' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('confirmation-1'));
  });

  it('已完成课程后来修改名单时，仍保留原课次参与人的更正入口', () => {
    const base = createDemoData();
    const completed = {
      ...base.schedules[0],
      participants: ['s2'],
      attendance: [{ lessonId: 'lesson-1', studentId: 's1', status: 'attended' as const, updatedAt: 'v1' }],
    };
    const { actions } = setup({ ...base, schedules: [completed] });
    render(<ScheduleDetails actions={actions} item={completed} />);
    expect(screen.getByRole('button', { name: '更正李雨桐的出勤状态' })).toBeInTheDocument();
  });
});
