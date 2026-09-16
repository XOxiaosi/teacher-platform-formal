import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelConfiguration } from './ModelConfiguration';
import type { ProviderConfigDto } from '../api/types';

const apiRequest = vi.hoisted(() => vi.fn());
const listProviderConfigs = vi.hoisted(() => vi.fn());
const createProviderConfig = vi.hoisted(() => vi.fn());
const updateProviderConfig = vi.hoisted(() => vi.fn());
const setPrimaryProviderConfig = vi.hoisted(() => vi.fn());
const me = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ apiRequest }));
vi.mock('../api/providerConfigs', () => ({ createProviderConfig, listProviderConfigs, updateProviderConfig, setPrimaryProviderConfig }));
vi.mock('../api/auth', () => ({ me }));

const config = (overrides: Partial<ProviderConfigDto> = {}): ProviderConfigDto => ({
  id: 'cfg-1', providerKind: 'openai', providerName: '本地供应商', displayName: '主要模型', baseUrl: 'https://api.example.test/v1', apiKeyMasked: 'sk-…1234', model: 'model-a', isPrimary: true, status: 'active', createdAtTs: '2026-09-09T00:00:00Z', updatedAtTs: '2026-09-09T00:00:00Z', ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  listProviderConfigs.mockResolvedValue([config()]);
  apiRequest.mockResolvedValue({ configurationEnabled: true, runtimeEnabled: false, connectionTestEnabled: false, endpointValidation: 'dns-guarded' });
  me.mockResolvedValue({ id: 'teacher-a', email: 'teacher@example.test', displayName: '教师' });
  setPrimaryProviderConfig.mockResolvedValue(config({ isPrimary: true }));
  updateProviderConfig.mockResolvedValue(config());
  createProviderConfig.mockResolvedValue(config({ id: 'cfg-2', isPrimary: false }));
});

describe('ModelConfiguration', () => {
  it('loads real configurations and marks the saved primary selection', async () => {
    render(<ModelConfiguration teacherId="teacher-a" />);
    expect(await screen.findByLabelText('选择 主要模型')).toBeChecked();
    expect(screen.getByText(/模型运行能力尚未开启/)).toBeInTheDocument();
    expect(screen.getByText(/正式 AI 服务将由平台统一提供 DeepSeek/)).toBeInTheDocument();
    expect(screen.getByText(/教师无需填写自己的 API Key/)).toBeInTheDocument();
    expect(screen.getByText(/Key sk-…1234/)).toBeInTheDocument();
  });

  it('saves a changed primary configuration with the exact PATCH intent', async () => {
    listProviderConfigs.mockResolvedValue([config(), config({ id: 'cfg-2', displayName: '备用模型', isPrimary: false })]);
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('选择 备用模型');
    fireEvent.click(screen.getByLabelText('选择 备用模型'));
    fireEvent.click(screen.getByRole('button', { name: '保存默认模型' }));
    await waitFor(() => expect(setPrimaryProviderConfig).toHaveBeenCalledWith('teacher-a', 'cfg-2'));
  });

  it('updates model and URL without resending the masked or blank key', async () => {
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('模型 ID');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'model-b' } });
    fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://api.example.test/v2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(updateProviderConfig).toHaveBeenCalledWith('teacher-a', 'cfg-1', { baseUrl: 'https://api.example.test/v2', model: 'model-b' }));
  });

  it('creates a new API configuration from user input', async () => {
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('选择 主要模型');
    fireEvent.click(screen.getByRole('button', { name: '添加 API' }));
    fireEvent.change(screen.getByLabelText('供应商名称'), { target: { value: '手动供应商' } });
    fireEvent.change(screen.getAllByLabelText('API 地址').at(-1)!, { target: { value: 'https://provider.example.test/v1' } });
    fireEvent.change(screen.getAllByLabelText('模型 ID').at(-1)!, { target: { value: 'custom-model' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'user-entered-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 API 配置' }));
    await waitFor(() => expect(createProviderConfig).toHaveBeenCalledWith('teacher-a', expect.objectContaining({ providerName: '手动供应商', baseUrl: 'https://provider.example.test/v1', model: 'custom-model', apiKey: 'user-entered-key' })));
  });

  it('keeps input after save failure and prevents duplicate submits while busy', async () => {
    let resolveUpdate!: (value: ProviderConfigDto) => void;
    updateProviderConfig.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('模型 ID');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'keep-me' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(updateProviderConfig).toHaveBeenCalledTimes(1));
    resolveUpdate(config({ model: 'keep-me' }));
    await waitFor(() => expect(screen.getByLabelText('模型 ID')).toHaveValue('keep-me'));
  });

  it('keeps the draft and shows the rejected error', async () => {
    updateProviderConfig.mockRejectedValueOnce(new Error('保存被拒绝'));
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('模型 ID');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'reject-keeps-me' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存被拒绝');
    expect(screen.getByLabelText('模型 ID')).toHaveValue('reject-keeps-me');
  });

  it('clears a submitted key and locks writes until a failed refresh is recovered', async () => {
    listProviderConfigs.mockResolvedValueOnce([config()]).mockRejectedValueOnce(new Error('刷新失败')).mockResolvedValueOnce([config({ updatedAtTs: '2026-09-09T00:01:00Z' })]);
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('模型 ID');
    fireEvent.change(screen.getByLabelText(/替换 API Key/), { target: { value: 'one-time-key' } });
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'saved-model' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(screen.getByLabelText(/替换 API Key/)).toHaveValue(''));
    expect(await screen.findByRole('alert')).toHaveTextContent('已保存，但最新配置加载失败');
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载后解锁' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled());
  });

  it('does not reload or publish an old mutation after teacher identity changes', async () => {
    let resolveUpdate!: (value: ProviderConfigDto) => void;
    updateProviderConfig.mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));
    listProviderConfigs.mockResolvedValueOnce([config()]).mockResolvedValue([config({ id: 'new', displayName: '新教师配置' })]);
    const identities = [{ id: 'teacher-old', email: 'old@example.test', displayName: '旧' }, { id: 'teacher-old', email: 'old@example.test', displayName: '旧' }, { id: 'teacher-old', email: 'old@example.test', displayName: '旧' }, { id: 'teacher-new', email: 'new@example.test', displayName: '新' }, { id: 'teacher-new', email: 'new@example.test', displayName: '新' }];
    me.mockImplementation(() => Promise.resolve(identities.shift() ?? identities.at(-1)));
    const view = render(<ModelConfiguration teacherId="teacher-old" />);
    await screen.findByLabelText('模型 ID');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'old-draft' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(updateProviderConfig).toHaveBeenCalledTimes(1));
    const loadCallsBeforeFinish = listProviderConfigs.mock.calls.length;
    view.rerender(<ModelConfiguration teacherId="teacher-new" />);
    await waitFor(() => expect(listProviderConfigs).toHaveBeenCalledTimes(loadCallsBeforeFinish + 1));
    resolveUpdate(config({ model: 'old-draft' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listProviderConfigs).toHaveBeenCalledTimes(loadCallsBeforeFinish + 1);
    expect(screen.queryByText('配置已保存。')).not.toBeInTheDocument();
  });

  it('disables all writes when configuration capability is off', async () => {
    apiRequest.mockResolvedValueOnce({ configurationEnabled: false, runtimeEnabled: true, connectionTestEnabled: false, endpointValidation: 'static' });
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('选择 主要模型');
    expect(screen.getByRole('button', { name: '添加 API' })).toBeDisabled();
    expect(screen.getByText(/暂不可修改/)).toBeInTheDocument();
  });

  it('rejects a changed cookie identity before writing and hides the old configuration', async () => {
    me.mockResolvedValueOnce({ id: 'teacher-a', email: 'a@example.test', displayName: '甲' })
      .mockResolvedValueOnce({ id: 'teacher-a', email: 'a@example.test', displayName: '甲' })
      .mockResolvedValueOnce({ id: 'teacher-b', email: 'b@example.test', displayName: '乙' });
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('选择 主要模型');
    fireEvent.click(screen.getByRole('button', { name: '添加 API' }));
    fireEvent.change(screen.getByLabelText('供应商名称'), { target: { value: '不应写入' } });
    fireEvent.change(screen.getAllByLabelText('API 地址').at(-1)!, { target: { value: 'https://provider.example.test/v1' } });
    fireEvent.change(screen.getAllByLabelText('模型 ID').at(-1)!, { target: { value: 'blocked-model' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'blocked-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 API 配置' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前登录身份已变化'));
    expect(createProviderConfig).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('blocked-key')).not.toBeInTheDocument();
  });

  it('shows an empty state and lets the user retry a failed load', async () => {
    listProviderConfigs.mockRejectedValueOnce(new Error('服务暂时不可用')).mockResolvedValueOnce([]);
    render(<ModelConfiguration teacherId="teacher-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('当前账号还没有模型配置')).toBeInTheDocument();
  });

  it('keeps the first API form and key when creation is rejected', async () => {
    listProviderConfigs.mockResolvedValue([]);
    createProviderConfig.mockRejectedValueOnce(new Error('地址被拒绝'));
    render(<ModelConfiguration teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '添加 API' }));
    fireEvent.change(screen.getByLabelText('供应商名称'), { target: { value: '供应商' } });
    fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://example.test/v1' } });
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'first-model' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 API 配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('地址被拒绝');
    expect(screen.getByRole('form', { name: '添加 API 配置' })).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toHaveValue('synthetic-key');
    expect(screen.getByLabelText('模型 ID')).toHaveValue('first-model');
  });

  it('does not retry an already-created API when the post-save identity refresh fails', async () => {
    render(<ModelConfiguration teacherId="teacher-a" />);
    await screen.findByLabelText('选择 主要模型');
    fireEvent.click(screen.getByRole('button', { name: '添加 API' }));
    fireEvent.change(screen.getByLabelText('供应商名称'), { target: { value: '新供应商' } });
    fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://example.test/v1' } });
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'new-model' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'clear-this-key' } });
    me.mockResolvedValueOnce({ id: 'teacher-a' }).mockRejectedValueOnce(new Error('身份查询暂时失败'));
    fireEvent.click(screen.getByRole('button', { name: '保存 API 配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已保存，但最新配置加载失败');
    expect(createProviderConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('form', { name: '添加 API 配置' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('clear-this-key')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加 API' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载后解锁' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '添加 API' })).toBeEnabled());
    expect(createProviderConfig).toHaveBeenCalledTimes(1);
  });

  it('protects unsaved model edits from default selection and adding another API', async () => {
    listProviderConfigs.mockResolvedValue([config(), config({ id: 'cfg-2', displayName: '备用模型', isPrimary: false })]);
    render(<ModelConfiguration teacherId="teacher-a" />);
    fireEvent.click(await screen.findByLabelText('选择 备用模型'));
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'unsaved-model' } });
    expect(screen.getByRole('button', { name: '保存默认模型' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消默认选择' }));
    expect(screen.getByLabelText('选择 备用模型')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '添加 API' }));
    expect(screen.queryByRole('form', { name: '添加 API 配置' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('模型 ID')).toHaveValue('unsaved-model');
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    expect(screen.getByRole('button', { name: '保存默认模型' })).toBeEnabled();
  });

});
