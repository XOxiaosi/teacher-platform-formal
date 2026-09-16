import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewApp } from './PreviewApp';
import { revisionTimeLabel } from './ScheduleDetails';

function route(path: string) { act(() => { window.history.replaceState(null, '', path); window.dispatchEvent(new HashChangeEvent('hashchange')); }); }
afterEach(() => window.history.replaceState(null, '', '/'));

describe('UI审查修复：工作台与缴费', () => {
  it('修订时间使用上海日期而非UTC截取日期', () => {
    expect(revisionTimeLabel('2026-09-09T19:30:00Z')).toBe('2026年9月10日 03:30');
  });
  it('筛选后统计、空态、新增对象一致，并保留跨页筛选', () => {
    route('#/finance'); render(<PreviewApp />);
    fireEvent.change(screen.getByLabelText('查看学生'), { target: { value: 's2' } });
    expect(screen.getByText('暂无缴费记录')).toBeInTheDocument();
    expect(screen.getByLabelText('王浩然的课时概览')).toHaveTextContent('剩余课时2');
    fireEvent.click(screen.getByRole('button', { name: '登记第一笔缴费' }));
    expect(screen.getByLabelText('学生')).toHaveValue('s2');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    route('#/students'); route('#/finance');
    expect(screen.getByLabelText('查看学生')).toHaveValue('s2');
  });

  it('缴费确认展示余额变化，返回修改保留内容，只确认后记账', () => {
    route('#/finance'); render(<PreviewApp />);
    fireEvent.change(screen.getByLabelText('查看学生'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: '登记缴费' }));
    fireEvent.change(screen.getByLabelText('金额'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('增加课时'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('2 → 7');
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    expect(screen.getByLabelText('金额')).toHaveValue(500);
    expect(screen.getByLabelText('增加课时')).toHaveValue(5);
    expect(screen.getByLabelText('王浩然的课时概览')).toHaveTextContent('剩余课时2');
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    expect(screen.getByLabelText('王浩然的课时概览')).toHaveTextContent('剩余课时7');
    expect(screen.queryByText('暂无缴费记录')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('¥500');
  });

  it('首页以分组区分已完成和待上，取消后不计入今日排期', () => {
    route('#/today'); render(<PreviewApp />);
    expect(within(screen.getByRole('region', { name: '已完成课程' })).getByRole('button')).toHaveTextContent('李雨桐');
    fireEvent.click(screen.getByRole('button', { name: /查看 19:00 至 20:30 陈乐言/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消仅本次' }));
    expect(screen.getByText(/今天有 2 项排期/)).toBeInTheDocument();
    expect(screen.getByText('已取消课程 · 1')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '待上课程' })).queryByText('陈乐言')).not.toBeInTheDocument();
  });

  it('助手不再声称保存响应偏好就能连接模型', () => {
    route('#/agent'); render(<PreviewApp />);
    expect(screen.getByText('助手暂不可用')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '记录学生情况' })).toHaveAttribute('href', '#/students');
    expect(screen.getByRole('link', { name: '设置响应偏好' })).toHaveAttribute('href', '#/settings/models');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });
});
