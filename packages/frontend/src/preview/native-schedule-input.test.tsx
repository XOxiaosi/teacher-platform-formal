import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoData, type DemoData, type Schedule } from './data';
import type { PreviewActions } from './PreviewApp';
import { EditScheduleForm, NewScheduleForm } from './ScheduleForm';
import { SchedulesPage } from './SchedulePage';

function setup(data: DemoData) {
  let opened: ReactNode = null;
  const open = vi.fn((_title: string, body: ReactNode) => { opened = body; });
  const actions: PreviewActions = {
    data,
    setData: vi.fn(),
    ui: {},
    setUi: vi.fn(),
    open,
    toast: vi.fn(),
    close: vi.fn(),
    complete: vi.fn(),
    saveSchedule: vi.fn(),
    cancelSchedule: vi.fn(),
    editCompletedSchedule: vi.fn(),
    saveRule: vi.fn(),
    replaceRuleFrom: vi.fn(),
    endRuleBefore: vi.fn(),
    setRuleEnabled: vi.fn(),
    addPayment: vi.fn(),
  };
  return { actions, dialog: () => render(<>{opened}</>) };
}

function inputScheduleDateAndTimes(day: string, start: string, end: string) {
  fireEvent.input(screen.getByLabelText('日期'), { target: { value: day } });
  fireEvent.input(screen.getByLabelText('开始时间'), { target: { value: start } });
  fireEvent.input(screen.getByLabelText('结束时间'), { target: { value: end } });
}

describe('native schedule date/time inputs', () => {
  it('starts a new course on the server business date when viewing the current week', () => {
    location.hash = '#/schedules';
    const { actions, dialog } = setup({ ...createDemoData(), businessDate: '2026-09-10', schedules: [], recurrenceRules: [] });
    render(<SchedulesPage actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: '+ 新增排期' }));
    dialog();
    expect(screen.getByLabelText('日期')).toHaveValue('2026-09-10');
  });
  it('submits NewScheduleForm values entered through native input events', () => {
    const { actions } = setup({ ...createDemoData(), schedules: [], recurrenceRules: [] });
    render(<NewScheduleForm actions={actions} initialDay="2026-09-07" initialStudentId="s2" />);

    expect(screen.getByLabelText('日期')).toHaveValue('2026-09-07');
    expect(screen.getByLabelText('开始时间')).toHaveValue('10:00');
    expect(screen.getByLabelText('结束时间')).toHaveValue('11:00');
    inputScheduleDateAndTimes('2026-09-10', '09:00', '10:00');
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '输入事件工作室' } });
    fireEvent.click(screen.getByRole('button', { name: '保存排期' }));

    expect(actions.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      day: '2026-09-10', start: '09:00', end: '10:00', location: '输入事件工作室', participants: ['s2'],
    }));
  });

  it('carries EditScheduleForm native input values into confirmation and the saved schedule', () => {
    const base = createDemoData();
    const schedule: Schedule = {
      ...base.schedules[3], day: '2026-09-07', start: '10:00', end: '11:00', location: '编辑前工作室', participants: ['s2'],
    };
    const { actions, dialog } = setup({ ...base, schedules: [schedule], recurrenceRules: [] });
    render(<EditScheduleForm actions={actions} schedule={schedule} scope="this" />);

    inputScheduleDateAndTimes('2026-09-10', '09:00', '10:00');
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    dialog();
    expect(screen.getByText('新值').parentElement).toHaveTextContent('2026年9月10日 09:00–10:00');

    fireEvent.click(screen.getByRole('button', { name: '确认仅本次修改' }));
    expect(actions.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: schedule.id, day: '2026-09-10', start: '09:00', end: '10:00', location: '编辑前工作室',
    }));
  });
});
