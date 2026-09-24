import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmationTurnDto } from '../../api/conversations';
import { ConfirmationBatch } from './ConfirmationBatch';

const turn = (actionId: string, actionName: string, afterSummary: string): ConfirmationTurnDto => ({
  id: `turn-${actionId}`, conversationId: 'conversation-1', kind: 'confirmation', actionId, actionName,
  target: { type: actionName === 'memos.create' ? 'Memo' : 'Schedule', id: `target-${actionId}` },
  beforeSummary: null, afterSummary, parameterSummary: {}, status: 'pending',
  expiresAt: '2099-12-31T23:59:59.000Z', actionToken: `token-${actionId}`, error: null,
  createdAt: '2026-09-23T12:00:00Z',
});

const turns = [
  turn('schedule-1', 'scheduling.create', '周三 19:00 为小明安排数学课。'),
  turn('memo-1', 'memos.create', '记录：周五提醒家长反馈。'),
];

describe('ConfirmationBatch', () => {
  it('默认选中全部项目并一次回传所选 action ids 和 turns', () => {
    const onConfirm = vi.fn();
    render(<ConfirmationBatch turns={turns} onConfirm={onConfirm} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox').every(input => (input as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '确认选中的 2 项' }));
    expect(onConfirm).toHaveBeenCalledWith(['schedule-1', 'memo-1'], turns);
  });

  it('取消一项后只回传剩余选中项目', () => {
    const onConfirm = vi.fn();
    render(<ConfirmationBatch turns={turns} onConfirm={onConfirm} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    fireEvent.click(screen.getByRole('button', { name: '确认选中的 1 项' }));
    expect(onConfirm).toHaveBeenCalledWith(['schedule-1'], [turns[0]]);
  });

  it('没有选中项目时禁用确认按钮', () => {
    const view = render(<ConfirmationBatch turns={turns} onConfirm={vi.fn()} />);
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: '确认选中的 0 项' })).toBeDisabled();
    view.rerender(<ConfirmationBatch turns={[...turns]} itemStates={{}} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: '确认选中的 0 项' })).toBeDisabled();
  });

  it('新增候选时只默认选中新项并保留教师已取消的旧选择', () => {
    const view = render(<ConfirmationBatch turns={turns} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    const added = turn('memo-2', 'memos.create', '下周一回访家长。');
    view.rerender(<ConfirmationBatch turns={[...turns, added]} itemStates={{}} onConfirm={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.map(checkbox => checkbox.checked)).toEqual([true, false, true]);
  });

  it('选中项目正在提交时禁用批量确认按钮', () => {
    render(<ConfirmationBatch turns={turns} itemStates={{ 'schedule-1': { busy: true } }} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: '确认选中的 2 项' })).toBeDisabled();
  });

  it('不选择无 token 或已过期的项目，也不把它们计入确认数量', () => {
    const unavailable = [
      { ...turns[0]!, actionToken: null },
      { ...turns[1]!, expiresAt: '2020-01-01T00:00:00.000Z' },
    ];
    render(<ConfirmationBatch turns={unavailable} onConfirm={vi.fn()} />);
    expect(screen.getAllByRole('checkbox').every(input => (input as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getAllByText('已过期')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '确认选中的 0 项' })).toBeDisabled();
  });

  it('显示部分成功与失败的真实状态，成功项不可再选', () => {
    render(<ConfirmationBatch turns={turns} itemStates={{
      'schedule-1': { status: 'consumed' },
      'memo-1': { status: 'pending', error: '保存待办失败，请重试。' },
    }} onConfirm={vi.fn()} />);
    expect(screen.getByText('已保存')).toBeInTheDocument();
    expect(screen.getByText('需重试')).toBeInTheDocument();
    expect(screen.getByText('保存待办失败，请重试。')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    expect(screen.getAllByRole('checkbox')[1]).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '确认选中的 1 项' })).toBeEnabled();
  });
});
