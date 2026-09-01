import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminUsageApi from '../api/adminUsage';
import type { AdminUsageSummary } from '../api/adminUsage';
import { AdminUsagePage } from './AdminUsagePage';

vi.mock('../api/adminUsage');

const summary: AdminUsageSummary = {
  from: '2026-07-02T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, requests: 12 },
  byProvider: [
    { providerName: 'deepseek', model: 'deepseek-chat', promptTokens: 800, completionTokens: 200, totalTokens: 1000, requests: 8 },
    { providerName: 'anthropic', model: 'claude-3-5-sonnet', promptTokens: 400, completionTokens: 100, totalTokens: 500, requests: 4 },
  ],
};

const emptySummary: AdminUsageSummary = {
  from: '2026-07-02T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 },
  byProvider: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminUsageApi.getAdminUsageSummary).mockResolvedValue(summary);
});

describe('AdminUsagePage（/admin/usage 平台级用量费用看板）', () => {
  it('渲染 totals 卡片 + byProvider 明细 + 时段按钮（默认全平台 30d）', async () => {
    render(<AdminUsagePage />);

    expect(await screen.findByRole('heading', { name: '用量费用看板' })).toBeInTheDocument();
    expect(screen.getByText('全平台 · 近 30 天')).toBeInTheDocument();

    // 指标卡
    expect(screen.getByText('总 Token')).toBeInTheDocument();
    expect(screen.getAllByText('1,500').length).toBeGreaterThan(0);
    expect(screen.getByText('输入 Token')).toBeInTheDocument();
    expect(screen.getByText('请求次数')).toBeInTheDocument();

    // byProvider 明细
    expect(screen.getByText('按 Provider 明细')).toBeInTheDocument();
    expect(screen.getByText('deepseek')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();

    // 时段按钮默认 30d 选中
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '近 30 天' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '近 90 天' })).toHaveAttribute('aria-pressed', 'false');

    expect(adminUsageApi.getAdminUsageSummary).toHaveBeenCalledWith(expect.objectContaining({
      from: expect.any(String),
      to: expect.any(String),
      teacherId: undefined,
    }));
  });

  it('时段切换：7d/90d 重算 from/to（span = days）', async () => {
    render(<AdminUsagePage />);
    await screen.findByText('全平台 · 近 30 天');

    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(() => expect(adminUsageApi.getAdminUsageSummary).toHaveBeenCalledTimes(2));
    let last = vi.mocked(adminUsageApi.getAdminUsageSummary).mock.calls.at(-1)![0];
    expect(new Date(last.to).getTime() - new Date(last.from).getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('全平台 · 近 7 天')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '近 90 天' }));
    await waitFor(() => expect(adminUsageApi.getAdminUsageSummary).toHaveBeenCalledTimes(3));
    last = vi.mocked(adminUsageApi.getAdminUsageSummary).mock.calls.at(-1)![0];
    expect(new Date(last.to).getTime() - new Date(last.from).getTime()).toBe(90 * 24 * 3600 * 1000);
    expect(screen.getByText('全平台 · 近 90 天')).toBeInTheDocument();
  });

  it('教师钻取：输入 teacherId 应用 → 带参数请求 + 视图标注；清除回到全平台', async () => {
    render(<AdminUsagePage />);
    await screen.findByText('全平台 · 近 30 天');

    fireEvent.change(screen.getByLabelText('教师钻取'), { target: { value: 'teacher-1' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => expect(adminUsageApi.getAdminUsageSummary).toHaveBeenLastCalledWith(expect.objectContaining({
      teacherId: 'teacher-1',
    })));
    expect(screen.getByText('教师 teacher-1 · 近 30 天')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => expect(adminUsageApi.getAdminUsageSummary).toHaveBeenLastCalledWith(expect.objectContaining({
      teacherId: undefined,
    })));
    expect(screen.getByText('全平台 · 近 30 天')).toBeInTheDocument();
  });

  it('空态：全平台全零时展示「该时段平台暂无用量数据」', async () => {
    vi.mocked(adminUsageApi.getAdminUsageSummary).mockResolvedValue(emptySummary);

    render(<AdminUsagePage />);

    expect(await screen.findByText('该时段平台暂无用量数据。')).toBeInTheDocument();
    expect(screen.queryByText('按 Provider 明细')).not.toBeInTheDocument();
  });

  it('错误态：展示错误 + 重试按钮，点击重试重新拉取', async () => {
    vi.mocked(adminUsageApi.getAdminUsageSummary)
      .mockRejectedValueOnce(new Error('usage down'))
      .mockResolvedValue(summary);

    render(<AdminUsagePage />);

    expect(await screen.findByText('用量加载失败：usage down')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(adminUsageApi.getAdminUsageSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('总 Token')).toBeInTheDocument();
  });
});
