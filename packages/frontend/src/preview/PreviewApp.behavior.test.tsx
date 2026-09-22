import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewApp } from './PreviewApp';
import { scheduleGeometry, weekTimeRange } from './Workflows';

function route(path: string) {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('isolated preview behaviors', () => {
  it('renders without a login or network request', () => {
    route('#/today');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PreviewApp />);
    expect(screen.getByRole('heading', { name: '今日工作台' })).toBeInTheDocument();
    expect(screen.queryByText('登录')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before completing a schedule', () => {
    route('#/schedules');
    render(<PreviewApp />);
    fireEvent.click(screen.getByRole('button', { name: /查看 14:00 至 15:30 小班 · 2 人.*排期详情/ }));
    fireEvent.click(screen.getByRole('button', { name: '完成并确认' }));
    expect(screen.getByRole('dialog', { name: '确认完成排期' })).toBeInTheDocument();
    expect(screen.getByText(/每位参与人各扣 1 课时/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认完成' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /查看 14:00 至 15:30 小班 · 2 人.*排期详情/ }));
    expect(screen.queryByRole('button', { name: '完成并确认' })).not.toBeInTheDocument();
  });

  it('positions short and late schedules by actual clock minutes without expansion overlap', () => {
    const short = scheduleGeometry('14:00', '14:30');
    const next = scheduleGeometry('14:30', '15:00');
    const late = scheduleGeometry('19:00', '20:30');
    expect(short).toMatchObject({ top: 408, height: 31, compact: true });
    expect(next.top).toBe(442);
    expect(short.top + short.height).toBeLessThanOrEqual(next.top);
    expect(late).toMatchObject({ top: 748, height: 99, compact: false });
  });

  it('expands the visible clock for valid schedules outside the default day range', () => {
    const range = weekTimeRange([
      { id: 'early', day: '2026-09-08', start: '07:00', end: '07:30', location: 'A', participants: ['s1'], format: '一对一', note: '', status: '已排期' },
      { id: 'late', day: '2026-09-08', start: '21:00', end: '22:00', location: 'B', participants: ['s2'], format: '一对一', note: '', status: '已排期' },
    ]);
    expect(range).toEqual({ firstHour: 7, lastHour: 22, height: 1020 });
    expect(scheduleGeometry('07:00', '07:30', range.firstHour)).toMatchObject({ top: 0, compact: true });
    expect(scheduleGeometry('21:00', '22:00', range.firstHour)).toMatchObject({ top: 952, height: 65 });
  });

  it('keeps feedback local and provides copy rather than sending', () => {
    route('#/feedback');
    render(<PreviewApp />);
    expect(screen.getByRole('button', { name: '编辑草稿' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制草稿' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /发送/ })).not.toBeInTheDocument();
  });

  it('updates the studio name in the current example UI', () => {
    route('#/settings');
    render(<PreviewApp />);
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '演示工作室' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(screen.getByText('演示工作室')).toBeInTheDocument();
  });

  it('keeps small-group names out of schedule summaries and their aria labels', () => {
    route('#/schedules');
    render(<PreviewApp />);
    const summary = screen.getByRole('button', { name: /查看 14:00 至 15:30 小班 · 2 人.*排期详情/ });
    expect(summary).toHaveTextContent('小班 · 2 人');
    expect(summary).not.toHaveAccessibleName(/王浩然|张思远/);
    expect(screen.queryByText('王浩然')).not.toBeInTheDocument();
    expect(screen.queryByText('张思远')).not.toBeInTheDocument();
  });

  it('closes an open dialog on hash navigation to prevent cross-page edits', async () => {
    route('#/schedules');
    render(<PreviewApp />);
    fireEvent.click(screen.getByRole('button', { name: /查看 14:00 至 15:30 小班/ }));
    expect(screen.getByRole('dialog', { name: '排期详情' })).toBeInTheDocument();
    route('#/today');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not offer completion after a scheduled course is cancelled', () => {
    route('#/schedules');
    render(<PreviewApp />);
    fireEvent.click(screen.getByRole('button', { name: /查看 19:00 至 20:30 陈乐言/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消仅本次' }));
    fireEvent.click(screen.getByRole('button', { name: /查看 19:00 至 20:30 陈乐言/ }));
    expect(screen.getByRole('dialog', { name: '排期详情' })).toHaveTextContent('已取消');
    expect(screen.queryByRole('button', { name: '完成并确认' })).not.toBeInTheDocument();
  });
});
