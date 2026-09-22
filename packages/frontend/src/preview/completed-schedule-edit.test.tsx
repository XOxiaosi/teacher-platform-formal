import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoData } from './data';
import { EditScheduleForm } from './ScheduleForm';
import type { PreviewActions } from './PreviewApp';

function setup() {
  const data = createDemoData(); let opened: ReactNode = null;
  const actions: PreviewActions = { data, setData: vi.fn(), open: (_title, body) => { opened = body; }, toast: vi.fn(), close: vi.fn(), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), editCompletedSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), endRuleBefore: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn() };
  render(<EditScheduleForm actions={actions} schedule={data.schedules[0]} scope="this" />);
  return { actions, data, dialog: () => render(<>{opened}</>) };
}

describe('completed schedule editing', () => {
  it('confirms a completed-course edit and preserves its no-recharge boundary', () => {
    const { actions, dialog } = setup();
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '工作室 C' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '课后确认' } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    dialog();
    expect(screen.getByText('确认后不会重新扣课；原扣课记录保留。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    expect(actions.editCompletedSchedule).toHaveBeenCalledWith(expect.objectContaining({ status: '已完成' }), expect.objectContaining({ location: '工作室 C', note: '课后确认' }));
    expect(actions.complete).not.toHaveBeenCalled();
  });

  it('blocks an edited completed course that overlaps another schedule', () => {
    setup();
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '14:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '15:00' } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('该时段与现有排期冲突');
  });

  it('cancels an edit without writing a revision or completing again', () => {
    const { actions } = setup();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.editCompletedSchedule).not.toHaveBeenCalled();
    expect(actions.complete).not.toHaveBeenCalled();
  });

  it('returns from confirmation with the edited completed-course values intact', () => {
    const { dialog } = setup();
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '工作室 D' } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    dialog();
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    dialog();
    expect(screen.getAllByLabelText('地点').at(-1)).toHaveValue('工作室 D');
  });
});
