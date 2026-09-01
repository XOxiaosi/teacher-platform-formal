import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmConfigPage } from './LlmConfigPage';
import * as providerConfigsApi from '../../api/providerConfigs';
import type { ProviderConfigDto, ProviderTestResult, UsageSummary } from '../../api/types';
import { testHistoryKey } from './test-history';

vi.mock('../../api/providerConfigs');

const primaryConfig: ProviderConfigDto = {
  id: 'config-1',
  providerKind: 'openai',
  providerName: 'deepseek',
  displayName: null,
  baseUrl: 'https://api.deepseek.com',
  apiKeyMasked: 'sk-****0001',
  model: 'deepseek-chat',
  isPrimary: true,
  status: 'active',
  createdAtTs: '2026-08-01T10:00:00.000Z',
  updatedAtTs: '2026-08-01T10:00:00.000Z',
};

const secondaryConfig: ProviderConfigDto = {
  ...primaryConfig,
  id: 'config-2',
  providerKind: 'anthropic',
  providerName: 'anthropic',
  displayName: '备用 Claude',
  baseUrl: 'https://api.anthropic.com',
  apiKeyMasked: 'sk-****0002',
  model: 'claude-3-5-sonnet',
  isPrimary: false,
};

const usageSummary: UsageSummary = {
  from: '2026-07-02T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { promptTokens: 200, completionTokens: 50, totalTokens: 250, requests: 2 },
  byProvider: [
    {
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
      requests: 2,
    },
  ],
};

const emptyUsage: UsageSummary = {
  from: '2026-07-02T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 },
  byProvider: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(providerConfigsApi.listProviderConfigs).mockResolvedValue([primaryConfig, secondaryConfig]);
  vi.mocked(providerConfigsApi.getUsageSummary).mockResolvedValue(usageSummary);
  vi.mocked(providerConfigsApi.createProviderConfig).mockResolvedValue({
    ...primaryConfig,
    id: 'config-3',
    providerName: 'qwen',
    model: 'qwen-max',
    isPrimary: false,
  });
  vi.mocked(providerConfigsApi.updateProviderConfig).mockResolvedValue({
    ...primaryConfig,
    model: 'deepseek-chat-v3',
  });
  vi.mocked(providerConfigsApi.removeProviderConfig).mockResolvedValue({ removed: true });
  vi.mocked(providerConfigsApi.setPrimaryProviderConfig).mockResolvedValue({
    ...secondaryConfig,
    isPrimary: true,
  });
  vi.mocked(providerConfigsApi.testProviderConfig).mockResolvedValue({
    ok: true,
    providerName: 'deepseek',
    model: 'deepseek-chat',
  });
});

describe('LlmConfigPage', () => {
  it('加载并展示 provider 列表、主 LLM 徽标、masked key 与用量卡片', async () => {
    render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(screen.getByText('正在加载 LLM 配置')).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'LLM 配置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deepseek' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '备用 Claude' })).toBeInTheDocument();
    expect(screen.getAllByText('主 LLM')).toHaveLength(1);
    expect(screen.getByText('sk-****0001')).toBeInTheDocument();
    expect(screen.getByText('https://api.deepseek.com')).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();

    // 用量看板
    expect(screen.getByText('用量看板')).toBeInTheDocument();
    expect(screen.getByText('总 Token')).toBeInTheDocument();
    expect(screen.getAllByText('250').length).toBeGreaterThan(0);
    expect(screen.getByText('请求次数')).toBeInTheDocument();
    // Provider 维度分布 + 明细表
    expect(screen.getByText('按 Provider 用量')).toBeInTheDocument();
    expect(screen.getByText('合计')).toBeInTheDocument();
    // 时间段切换按钮
    expect(screen.getByRole('button', { name: '近 7 天' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '近 30 天' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '近 90 天' })).toBeInTheDocument();

    expect(providerConfigsApi.listProviderConfigs).toHaveBeenCalledWith('demo-teacher');
    // 挂载：1 次主窗口 + 6 个 30d 分桶
    await waitFor(() => expect(providerConfigsApi.getUsageSummary).toHaveBeenCalledTimes(7));
    expect(providerConfigsApi.getUsageSummary).toHaveBeenCalledWith(
      'demo-teacher',
      expect.any(String),
      expect.any(String),
    );
  });

  it('空列表展示空状态与「首条自动主 LLM」提示', async () => {
    vi.mocked(providerConfigsApi.listProviderConfigs).mockResolvedValue([]);
    vi.mocked(providerConfigsApi.getUsageSummary).mockResolvedValue(emptyUsage);

    render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(await screen.findByText('暂无 LLM 配置。新增第一条配置将自动设为主 LLM（平台默认模型将被替换）。'))
      .toBeInTheDocument();
    expect(screen.getByText('当前还没有任何配置——新增的第一条将自动设为主 LLM。')).toBeInTheDocument();
  });

  it('新增配置：调用 createProviderConfig，首条自动 primary 徽标同步', async () => {
    vi.mocked(providerConfigsApi.listProviderConfigs).mockResolvedValue([]);
    vi.mocked(providerConfigsApi.createProviderConfig).mockResolvedValue({
      ...primaryConfig,
      id: 'config-3',
      providerName: 'qwen',
      displayName: '备用通义',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyMasked: 'sk-****0003',
      model: 'qwen-max',
      isPrimary: true,
    });

    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByText('暂无 LLM 配置。新增第一条配置将自动设为主 LLM（平台默认模型将被替换）。');

    fireEvent.change(screen.getByLabelText('Provider 名称'), { target: { value: 'qwen' } });
    fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: '备用通义' } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-secret-0003' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'qwen-max' } });
    fireEvent.click(screen.getByRole('button', { name: '新增配置' }));

    expect(providerConfigsApi.createProviderConfig).toHaveBeenCalledWith('demo-teacher', {
      providerKind: 'openai',
      providerName: 'qwen',
      displayName: '备用通义',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-secret-0003',
      model: 'qwen-max',
    });

    expect(await screen.findByRole('heading', { name: '备用通义' })).toBeInTheDocument();
    expect(screen.getByText('主 LLM')).toBeInTheDocument();
  });

  it('编辑：改模型 → PATCH 调用（apiKey 留空不传）→ 卡片更新', async () => {
    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });

    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '编辑' }));

    const modelInput = within(card).getByLabelText('模型');
    fireEvent.change(modelInput, { target: { value: 'deepseek-chat-v3' } });
    fireEvent.click(within(card).getByRole('button', { name: '保存' }));

    expect(providerConfigsApi.updateProviderConfig).toHaveBeenCalledWith('demo-teacher', 'config-1', {
      displayName: undefined,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat-v3',
      apiKey: undefined,
    });

    expect(await screen.findByText('OpenAI 兼容 · deepseek-chat-v3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  });

  it('删除 primary：confirm 含回退提示；确认后调用 remove 并重新拉取列表', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(providerConfigsApi.listProviderConfigs)
      .mockResolvedValueOnce([primaryConfig, secondaryConfig])
      .mockResolvedValueOnce([secondaryConfig]);

    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });

    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '删除' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('删除主 LLM'));
    expect(providerConfigsApi.removeProviderConfig).toHaveBeenCalledWith('demo-teacher', 'config-1');
    await waitFor(() => expect(providerConfigsApi.listProviderConfigs).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'deepseek' })).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('删除取消：confirm 返回 false 时不调用 remove', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });

    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '删除' }));

    expect(providerConfigsApi.removeProviderConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'deepseek' })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('测试连通性成功：展示「最近测试」时间 + 连通正常 + provider/model', async () => {
    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });

    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '测试连通性' }));

    expect(providerConfigsApi.testProviderConfig).toHaveBeenCalledWith('demo-teacher', 'config-1');
    expect(await screen.findByText(/最近测试（.*）：连通正常：deepseek \/ deepseek-chat/)).toBeInTheDocument();
  });

  it('测试连通性失败：展示「最近测试」时间 + ProviderError kind 与 message', async () => {
    const failed: ProviderTestResult = {
      ok: false,
      providerError: {
        kind: 'auth',
        status: 401,
        message: 'invalid api key',
        retryable: false,
      },
    };
    vi.mocked(providerConfigsApi.testProviderConfig).mockResolvedValue(failed);

    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });

    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '测试连通性' }));

    expect(await screen.findByText(/最近测试（.*）：连通失败：密钥无效（401\/403）（401）· invalid api key/))
      .toBeInTheDocument();
  });

  it('Provider 列表按 isPrimary 排序：主 LLM 置顶（后端返回顺序无关）', async () => {
    // 后端按创建顺序返回（secondary 在前），前端应把主 LLM 排到最前
    vi.mocked(providerConfigsApi.listProviderConfigs).mockResolvedValue([secondaryConfig, primaryConfig]);

    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });

    const cards = Array.from(document.querySelectorAll('.llm-provider-card'));
    const cardTitles = cards.map((node) => node.querySelector('h4')?.textContent);
    expect(cardTitles[0]).toBe('deepseek'); // 主 LLM
    expect(cardTitles[1]).toBe('备用 Claude');
    expect(cards[0].querySelector('.llm-badge.primary')).not.toBeNull();
  });

  it('测试历史持久化：测试后写入 localStorage，重挂载（刷新）后「最近测试」仍可见', async () => {
    vi.mocked(providerConfigsApi.testProviderConfig).mockResolvedValue({
      ok: true,
      providerName: 'deepseek',
      model: 'deepseek-chat',
    });

    const first = render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });
    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '测试连通性' }));
    expect(await screen.findByText(/最近测试（.*）：连通正常：deepseek \/ deepseek-chat/)).toBeInTheDocument();

    // localStorage 已落盘（含前端记录的时间戳）
    const stored = JSON.parse(window.localStorage.getItem(testHistoryKey('demo-teacher')) ?? '{}');
    expect(stored['config-1'].testedAt).toEqual(expect.any(String));
    expect(stored['config-1'].result.ok).toBe(true);

    // 模拟刷新：卸载后重新渲染（listProviderConfigs 会再次调用）
    first.unmount();
    render(<LlmConfigPage teacherId="demo-teacher" />);
    expect(await screen.findByText(/最近测试（.*）：连通正常：deepseek \/ deepseek-chat/)).toBeInTheDocument();
  });

  it('测试历史按教师隔离：teacherId 不同的页面互不串数据', async () => {
    vi.mocked(providerConfigsApi.testProviderConfig).mockResolvedValue({
      ok: true,
      providerName: 'deepseek',
      model: 'deepseek-chat',
    });

    const first = render(<LlmConfigPage teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: 'deepseek' });
    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '测试连通性' }));
    await screen.findByText(/最近测试（.*）：连通正常：deepseek \/ deepseek-chat/);
    first.unmount();

    // 另一教师：无历史
    render(<LlmConfigPage teacherId="teacher-b" />);
    await screen.findByRole('heading', { name: 'deepseek' });
    expect(screen.queryByText(/最近测试/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(testHistoryKey('teacher-a'))).not.toBeNull();
    expect(window.localStorage.getItem(testHistoryKey('teacher-b'))).toBeNull();
  });

  it('删除配置：同步清理该 provider 的测试历史，重挂载后不再展示', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(providerConfigsApi.testProviderConfig).mockResolvedValue({
      ok: true,
      providerName: 'deepseek',
      model: 'deepseek-chat',
    });
    vi.mocked(providerConfigsApi.listProviderConfigs)
      .mockResolvedValueOnce([primaryConfig, secondaryConfig])
      .mockResolvedValueOnce([secondaryConfig]);

    const view = render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: 'deepseek' });
    const card = screen.getByRole('heading', { name: 'deepseek' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '测试连通性' }));
    await screen.findByText(/最近测试（.*）：连通正常：deepseek \/ deepseek-chat/);
    expect(JSON.parse(window.localStorage.getItem(testHistoryKey('demo-teacher')) ?? '{}')['config-1']).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(providerConfigsApi.listProviderConfigs).toHaveBeenCalledTimes(2));

    // 历史条目已清除
    expect(JSON.parse(window.localStorage.getItem(testHistoryKey('demo-teacher')) ?? '{}')['config-1']).toBeUndefined();

    // 重挂载后无「最近测试」残留
    view.unmount();
    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: '备用 Claude' });
    expect(screen.queryByText(/最近测试/)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('设为主 LLM：调用 setPrimary 并重新拉取列表（徽标唯一）', async () => {
    vi.mocked(providerConfigsApi.setPrimaryProviderConfig).mockResolvedValue({
      ...secondaryConfig,
      isPrimary: true,
    });
    vi.mocked(providerConfigsApi.listProviderConfigs)
      .mockResolvedValueOnce([primaryConfig, secondaryConfig])
      .mockResolvedValueOnce([
        { ...secondaryConfig, isPrimary: true },
        { ...primaryConfig, isPrimary: false },
      ]);

    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByRole('heading', { name: '备用 Claude' });

    const card = screen.getByRole('heading', { name: '备用 Claude' }).closest('.llm-provider-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '设为主 LLM' }));

    expect(providerConfigsApi.setPrimaryProviderConfig).toHaveBeenCalledWith('demo-teacher', 'config-2');
    await waitFor(() => expect(providerConfigsApi.listProviderConfigs).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('主 LLM')).toHaveLength(1);
  });

  it('用量加载失败：展示错误提示且不阻断 provider 列表', async () => {
    vi.mocked(providerConfigsApi.getUsageSummary).mockRejectedValue(new Error('usage down'));

    render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(await screen.findByText('用量加载失败：usage down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deepseek' })).toBeInTheDocument();
  });

  it('时间段切换：7d/90d 重新请求整窗口（from=to-days）并按新桶数分桶', async () => {
    render(<LlmConfigPage teacherId="demo-teacher" />);
    await screen.findByText('用量看板');
    await waitFor(() => expect(providerConfigsApi.getUsageSummary).toHaveBeenCalledTimes(7)); // 30d: 1+6

    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    // 7d: +1 主窗口 + 7 桶 = 15
    await waitFor(() => expect(providerConfigsApi.getUsageSummary).toHaveBeenCalledTimes(15));
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true');

    const calls = vi.mocked(providerConfigsApi.getUsageSummary).mock.calls;
    // calls[7] = 7d 主窗口（calls[0] 是 30d 主窗口，calls[1..6] 是 30d 桶）
    const [, from7, to7] = calls[7];
    expect(new Date(to7 as string).getTime() - new Date(from7 as string).getTime())
      .toBe(7 * 24 * 3600 * 1000);

    fireEvent.click(screen.getByRole('button', { name: '近 90 天' }));
    // 90d: +1 主窗口 + 6 桶 = 22
    await waitFor(() => expect(providerConfigsApi.getUsageSummary).toHaveBeenCalledTimes(22));
    const [, from90, to90] = vi.mocked(providerConfigsApi.getUsageSummary).mock.calls[15];
    expect(new Date(to90 as string).getTime() - new Date(from90 as string).getTime())
      .toBe(90 * 24 * 3600 * 1000);
  });

  it('趋势简图与 Provider 分布条形渲染（30d 分 6 桶）', async () => {
    const { container } = render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(await screen.findByText('用量看板')).toBeInTheDocument();
    expect(await screen.findByText('用量趋势')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.llm-trend-bar').length).toBe(6));

    expect(screen.getByText('按 Provider 用量')).toBeInTheDocument();
    expect(container.querySelectorAll('.llm-provider-bar').length).toBe(1); // deepseek 聚合 1 条
  });

  it('用量空态：全零时展示「该时段暂无用量数据」且不渲染趋势', async () => {
    vi.mocked(providerConfigsApi.getUsageSummary).mockResolvedValue(emptyUsage);

    render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(await screen.findByText('该时段（近 30 天）暂无用量数据。')).toBeInTheDocument();
    expect(screen.queryByText('用量趋势')).not.toBeInTheDocument();
    expect(screen.queryByText('总 Token')).not.toBeInTheDocument();
  });

  it('用量错误态：展示错误与重试按钮，点击重试后重新拉取并渲染看板', async () => {
    vi.mocked(providerConfigsApi.getUsageSummary)
      .mockRejectedValueOnce(new Error('usage down'))
      .mockResolvedValue(usageSummary);

    render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(await screen.findByText('用量加载失败：usage down')).toBeInTheDocument();
    const failedCalls = vi.mocked(providerConfigsApi.getUsageSummary).mock.calls.length;
    expect(failedCalls).toBe(7); // 主窗口失败导致整批失败

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(providerConfigsApi.getUsageSummary).toHaveBeenCalledTimes(failedCalls + 7));
    expect(await screen.findByText('总 Token')).toBeInTheDocument();
  });

  it('列表加载失败展示错误状态', async () => {
    vi.mocked(providerConfigsApi.listProviderConfigs).mockRejectedValue(new Error('network down'));

    render(<LlmConfigPage teacherId="demo-teacher" />);

    expect(await screen.findByText('LLM 配置加载失败')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });
});
