import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  createProviderConfig,
  getUsageSummary,
  listProviderConfigs,
  removeProviderConfig,
  setPrimaryProviderConfig,
  testProviderConfig,
  updateProviderConfig,
} from './providerConfigs';
import type { ProviderConfigDto } from './types';

const baseConfig: ProviderConfigDto = {
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

function mockSuccess<T>(data: T) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  } as Response);
}

function mockFailure(error: { code: string; message: string; field?: string }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    json: async () => ({ ok: false, error }),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('providerConfigs API client（契约 p7-llm-provider-design.md §2.2）', () => {
  it('listProviderConfigs 发 GET /provider-configs（credentials include，无 teacher header）', async () => {
    const fetchMock = mockSuccess([baseConfig]);

    await expect(listProviderConfigs('teacher-a')).resolves.toEqual([baseConfig]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/provider-configs', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
      },
      credentials: 'include',
    });
  });

  it('createProviderConfig 发 POST 携带完整 body', async () => {
    const fetchMock = mockSuccess(baseConfig);

    await createProviderConfig('teacher-a', {
      providerKind: 'openai',
      providerName: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret',
      model: 'deepseek-chat',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/provider-configs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        providerKind: 'openai',
        providerName: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-secret',
        model: 'deepseek-chat',
      }),
    });
  });

  it('updateProviderConfig 发 PATCH 到 :id 路径且编码 id', async () => {
    const fetchMock = mockSuccess({ ...baseConfig, model: 'deepseek-v3' });

    await updateProviderConfig('teacher-a', 'cfg/1', { model: 'deepseek-v3', apiKey: 'sk-new' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/provider-configs/cfg%2F1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ model: 'deepseek-v3', apiKey: 'sk-new' }),
    });
  });

  it('removeProviderConfig 发 DELETE 到 :id 路径', async () => {
    const fetchMock = mockSuccess({ removed: true });

    await expect(removeProviderConfig('teacher-a', 'config-1')).resolves.toEqual({ removed: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/provider-configs/config-1', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('testProviderConfig 发 POST 到 :id/test', async () => {
    const fetchMock = mockSuccess({ ok: true, providerName: 'deepseek', model: 'deepseek-chat' });

    await testProviderConfig('teacher-a', 'config-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/provider-configs/config-1/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('setPrimaryProviderConfig 发 PATCH {isPrimary:true}（唯一化由后端保证）', async () => {
    const fetchMock = mockSuccess(baseConfig);

    await setPrimaryProviderConfig('teacher-a', 'config-2');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/provider-configs/config-2', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isPrimary: true }),
    });
  });

  it('getUsageSummary 用 URLSearchParams 编码 from/to ISO 时间', async () => {
    const fetchMock = mockSuccess({
      from: '2026-07-02T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      totals: { promptTokens: 200, completionTokens: 50, totalTokens: 250, requests: 2 },
      byProvider: [],
    });

    await getUsageSummary('teacher-a', '2026-07-02T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/usage/summary?from=2026-07-02T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z',
      expect.objectContaining({
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('后端 CommonError 继续作为 ApiError 传播（VALIDATION_ERROR）', async () => {
    mockFailure({ code: 'VALIDATION_ERROR', message: 'from/to 必填', field: 'query' });

    await expect(getUsageSummary('teacher-a', '', '')).rejects.toBeInstanceOf(ApiError);
    await expect(getUsageSummary('teacher-a', '', '')).rejects.toMatchObject({
      error: { code: 'VALIDATION_ERROR', field: 'query' },
    });
  });

  it('apiKey 只写不回：客户端绝不读取 apiKey 字段（响应仅含 apiKeyMasked）', async () => {
    mockSuccess([baseConfig]);
    const list = await listProviderConfigs('teacher-a');
    expect(list[0]).not.toHaveProperty('apiKey');
    expect(list[0]).not.toHaveProperty('apiKeyEnc');
    expect(list[0].apiKeyMasked).toBe('sk-****0001');
  });
});
