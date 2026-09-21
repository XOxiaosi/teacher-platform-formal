import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSupport } from './WorkspaceSupport';
import type { PreviewActions } from './PreviewApp';
import { createDemoData } from './data';

function Harness({ connected = false }: { connected?: boolean }) {
  const [data, setData] = useState(createDemoData);
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [visible, setVisible] = useState(true);
  const actions: PreviewActions = { connected, data, setData, ui, setUi, open: vi.fn(), close: vi.fn(), toast: vi.fn(), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn() };
  return <><button onClick={() => setVisible(!visible)}>切换页面</button>{visible && <WorkspaceSupport actions={actions} />}</>;
}

describe('WorkspaceSupport', () => {
  it('retains and clears preview preferences without network or persistent storage', () => {
    const fetch = vi.spyOn(window, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('教学背景'), { target: { value: '初中数学' } });
    fireEvent.click(screen.getByRole('button', { name: '保存演示偏好' }));
    expect(screen.getByRole('status')).toHaveTextContent('尚未写入助手记忆');
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }));
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }));
    expect(screen.getByLabelText('教学背景')).toHaveValue('初中数学');
    fireEvent.click(screen.getByRole('button', { name: '清除演示偏好' }));
    expect(screen.getByLabelText('教学背景')).toHaveValue('');
    expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
    fetch.mockRestore(); storage.mockRestore();
  });
  it('requires a complete issue and labels the result unsubmitted, preserving it for editing', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('记录一个使用问题'));
    fireEvent.click(screen.getByRole('button', { name: '保留演示问题' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请填写');
    fireEvent.change(screen.getByLabelText('问题标题'), { target: { value: '找不到记录' } });
    fireEvent.change(screen.getByLabelText('具体情况'), { target: { value: '保存后尚未显示。' } });
    fireEvent.click(screen.getByRole('button', { name: '保留演示问题' }));
    expect(screen.getByRole('status')).toHaveTextContent('未提交');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('具体情况')).toHaveValue('保存后尚未显示。');
  });
  it('does not offer simulated writes in a connected workspace', () => {
    render(<Harness connected />);
    fireEvent.click(screen.getByText('记录一个使用问题'));
    expect(screen.getByText(/教学偏好管理接口尚未接入/)).toBeInTheDocument();
    expect(screen.getByText(/问题反馈服务尚未接入/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存演示偏好' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('问题标题')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开微信连接 →' })).toHaveAttribute('href', '#/settings/wechat');
  });
});
