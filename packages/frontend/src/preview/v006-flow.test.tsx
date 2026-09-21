import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewApp, type PreviewActions } from './PreviewApp';
import { TodayPage } from './Today';
import { SettingsPage } from './SettingsConfiguration';
import { createDemoData } from './data';

afterEach(() => window.history.replaceState(null, '', '/'));

describe('V006 前端完整操作', () => {
  it('已完成课程改时间、地点、名单后仍保持完成和原扣课记录', async () => {
    window.history.replaceState(null, '', '#/schedules');
    render(<PreviewApp />);
    fireEvent.click(screen.getByRole('button', { name: /查看 09:00 至 10:30 李雨桐/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑课程' }));
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '12:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '13:00' } });
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '工作室 C' } });
    fireEvent.change(screen.getByLabelText('参与人'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    fireEvent.click(screen.getByRole('button', { name: /查看 12:00 至 13:00 王浩然 工作室 C/ }));
    const details = screen.getByRole('dialog');
    expect(within(details).getByText('王浩然')).toBeInTheDocument();
    expect(within(details).getByText('李雨桐：7 → 6 课时')).toBeInTheDocument();
    expect(within(details).getByText('修订记录')).toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: '完成并确认' })).not.toBeInTheDocument();
    fireEvent.click(within(details).getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('link', { name: '我的学生' }));
    expect(await screen.findByRole('link', { name: /李雨桐.*6 课时/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /王浩然.*2 课时/ })).toBeInTheDocument();
  }, 15_000);

  it.each(['today', 'students', 'schedules', 'finance', 'feedback', 'agent', 'settings/models', 'settings/wechat', 'settings/studio'])('正式业务页面 %s 没有开发说明', path => {
    window.history.replaceState(null, '', '#/' + path);
    const actions: PreviewActions = { connected: true, data: createDemoData(), setData: vi.fn(), open: vi.fn(), close: vi.fn(), toast: vi.fn(), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn() };
    const { container } = render(path === 'today' ? <TodayPage actions={actions} /> : path.startsWith('settings/') ? <SettingsPage actions={actions} /> : <PreviewApp />);
    expect(container).not.toHaveTextContent(/测试版|演示|示例|内存|刷新还原|伪造/);
  });
  it.each(['today', 'settings/models', 'settings/wechat'])('设计预览 %s 明确演示边界', path => {
    window.history.replaceState(null, '', '#/' + path);
    const { container } = render(<PreviewApp />);
    expect(container).toHaveTextContent(/合成演示|演示配置|演示界面/);
    expect(container).not.toHaveTextContent('微信发送已确认');
  });
});
