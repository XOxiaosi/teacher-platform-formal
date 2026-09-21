import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsConfiguration';
import { createDemoData } from './data';
import type { PreviewActions } from './PreviewApp';

function Harness({ connected = false, modelSettings }: { connected?: boolean; modelSettings?: ReactNode }) {
  const [data, setData] = useState(createDemoData);
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const actions: PreviewActions = { connected, data, setData, ui, setUi, open: vi.fn(), toast: vi.fn(), close: vi.fn(), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn() };
  return <SettingsPage actions={actions} modelSettings={modelSettings} />;
}

function setup(hash = '#/settings/models', options?: { connected?: boolean; modelSettings?: ReactNode }) {
  window.location.hash = hash;
  return render(<Harness {...options} />);
}

describe('SettingsConfiguration UI-005', () => {
  it('keeps the DSH + DeepSeek key in local component state and clears it after the demo submit', () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    setup();
    const key = screen.getByLabelText('DeepSeek API Key');
    fireEvent.change(key, { target: { value: 'sk-demo-only' } });
    fireEvent.click(screen.getByRole('button', { name: '提交演示配置' }));
    expect(key).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('演示配置已清空，未保存或验证 API Key');
    expect(screen.getByLabelText('DSH 到 DeepSeek 的演示连接路径')).toHaveTextContent('DSH');
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
    expect(screen.queryByText(/Base URL|供应商列表|模型列表/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStorage)).not.toContain('sk-demo-only');
    fetchSpy.mockRestore();
  });

  it('preserves the supplied formal model settings component', () => {
    setup('#/settings/models', { modelSettings: <div>正式模型设置内容</div> });
    expect(screen.getByRole('heading', { name: 'AI 服务' })).toBeInTheDocument();
    expect(screen.getByText('正式模型设置内容')).toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
  });

  it('never falls back to a demo key form when the connected model component is missing', () => {
    setup('#/settings/models', { connected: true });
    expect(screen.getByRole('status')).toHaveTextContent('暂无法获取服务状态');
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
    expect(screen.queryByText('提交演示配置')).not.toBeInTheDocument();
  });

  it('moves the demo QR from scan to optional pairing code to connected state, and keeps it across pages', async () => {
    setup('#/settings/wechat');
    fireEvent.click(screen.getByRole('button', { name: '打开演示二维码' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('二维码仅为不可扫码占位');
    fireEvent.click(screen.getByRole('button', { name: '演示：已扫码' }));
    expect(screen.getByRole('status')).toHaveTextContent('已扫码，等待手机确认');
    fireEvent.click(screen.getByText('手机要求输入配对码？（演示）'));
    fireEvent.change(screen.getByLabelText('演示配对数字'), { target: { value: '482 916' } });
    expect(screen.getByLabelText('演示配对数字')).toHaveValue('482916');
    fireEvent.click(screen.getByRole('button', { name: '演示：手机已确认' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('连接成功（演示）· 真实收发未验证')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '重新连接（演示）' })).toHaveFocus());
    fireEvent.click(screen.getByRole('link', { name: '模型设置' }));
    await screen.findByRole('heading', { name: '模型设置' });
    fireEvent.click(screen.getByRole('link', { name: '微信连接' }));
    await screen.findByRole('heading', { name: '微信连接' });
    expect(await screen.findByText('连接成功（演示）· 真实收发未验证')).toBeInTheDocument();
  });

  it('supports QR expiry, retry, failure and cancel without claiming a real connection', async () => {
    setup('#/settings/wechat');
    const open = screen.getByRole('button', { name: '打开演示二维码' });
    fireEvent.click(open);
    fireEvent.click(screen.getByRole('button', { name: '演示：二维码已过期' }));
    expect(screen.getByRole('status')).toHaveTextContent('二维码已过期（演示）');
    fireEvent.click(screen.getByRole('button', { name: '刷新演示二维码' }));
    fireEvent.click(screen.getByRole('button', { name: '演示：连接失败' }));
    expect(screen.getByRole('status')).toHaveTextContent('连接失败（演示）');
    fireEvent.click(screen.getByRole('button', { name: '重试演示连接' }));
    fireEvent.click(screen.getByRole('button', { name: '取消演示连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(open).toHaveFocus());
    expect(screen.getByText('已取消演示连接')).toBeInTheDocument();
    expect(screen.queryByText('连接成功（演示）· 真实收发未验证')).not.toBeInTheDocument();
  });

  it('does not simulate WeChat success when an integrated connection boundary is present', () => {
    setup('#/settings/wechat', { connected: true });
    expect(screen.getByText('微信连接服务尚未接入，暂无法获取连接状态。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '扫码连接暂不可用' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '打开演示二维码' })).not.toBeInTheDocument();
  });

  it('keeps preview privacy export local and never calls the real endpoint', () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    setup('#/settings/privacy');
    fireEvent.click(screen.getByRole('button', { name: '演示下载可读数据包' }));
    expect(screen.getByRole('status')).toHaveTextContent('演示环境未导出数据，也不会请求真实隐私接口。');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
