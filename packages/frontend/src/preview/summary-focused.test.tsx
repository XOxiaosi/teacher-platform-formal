import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewApp } from './PreviewApp';
import { scheduleGeometry } from './SchedulePage';

function route(path: string) { window.history.replaceState(null, '', path); window.dispatchEvent(new HashChangeEvent('hashchange')); }
afterEach(() => window.history.replaceState(null, '', '/'));

describe('课程摘要信息密度', () => {
  it('短课程保持原有高度，不因摘要增加而挤压下节课', () => {
    const short = scheduleGeometry('14:00', '14:30');
    const next = scheduleGeometry('14:30', '15:00');
    expect(short).toMatchObject({ compact: true, height: 31 });
    expect(short.top + short.height).toBeLessThanOrEqual(next.top);
  });

  it('周历显示三项摘要与状态，详情保留备注', () => {
    route('#/schedules'); render(<PreviewApp />);
    const item = screen.getByRole('button', { name: /查看 14:00 至 15:30/ });
    expect(item).toHaveTextContent('14:00–15:30');
    expect(item).toHaveTextContent('小班 · 2 人');
    expect(item).toHaveTextContent('工作室 B');
    expect(item).not.toHaveTextContent('课前小测');
    expect(item).toHaveTextContent('待上课');
    fireEvent.click(item);
    expect(screen.getByText('课前小测')).toBeInTheDocument();
  });

  it('列表以三项摘要卡呈现状态，不显示备注和形式', () => {
    route('#/schedules'); render(<PreviewApp />); fireEvent.click(screen.getByRole('button', { name: '列表' }));
    const card = screen.getByRole('button', { name: /查看 .*小班 · 2 人.*待上课 排期详情/ });
    expect(card).toHaveTextContent('时间');
    expect(card).toHaveTextContent('地点');
    expect(card).toHaveTextContent('对象');
    expect(card).toHaveTextContent('待上课');
    expect(card.textContent).toMatch(/年\d+月\d+日/);
    expect(card.textContent).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(screen.queryByText('课前小测')).not.toBeInTheDocument();
  });

  it('学生时间线只显示三项摘要，详情显示备注和小班名单', () => {
    route('#/students/s2'); render(<PreviewApp />);
    const timeline = screen.getByRole('heading', { name: '未来排期' }).parentElement;
    if (!timeline) throw new Error('未来排期容器未渲染');
    expect(timeline).not.toHaveTextContent('课前小测');
    expect(timeline).toHaveTextContent('对象：小班 · 2 人');
    expect(timeline.textContent).toMatch(/年\d+月\d+日/);
    expect(timeline.textContent).not.toMatch(/20\d\d-\d\d-\d\d/);
    fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[0]);
    expect(screen.getByText('课前小测')).toBeInTheDocument();
    expect(screen.getByText('王浩然、张思远')).toBeInTheDocument();
  });
});
