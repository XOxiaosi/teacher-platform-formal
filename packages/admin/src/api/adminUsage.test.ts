import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { getAdminUsageSummary } from './adminUsage';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const summary = {
  from: '2026-07-02T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, requests: 12 },
  byProvider: [
    { providerName: 'deepseek', model: 'deepseek-chat', promptTokens: 800, completionTokens: 200, totalTokens: 1000, requests: 8 },
    { providerName: 'anthropic', model: 'claude-3-5-sonnet', promptTokens: 400, completionTokens: 100, totalTokens: 500, requests: 4 },
  ],
};

describe('adminUsage api（契约：backend5 t28）', () => {
  it('getAdminUsageSummary 编码 from/to 且默认不带 teacherId（全平台）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: summary }));

    const result = await getAdminUsageSummary({
      from: '2026-07-02T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });

    expect(result.totals.totalTokens).toBe(1500);
    expect(result.byProvider).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/usage/summary?from=2026-07-02T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z',
      {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
      },
    );
  });

  it('传入 teacherId 时追加钻取参数；空白 teacherId 不发送', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: summary }));

    await getAdminUsageSummary({ from: 'a', to: 'b', teacherId: 'teacher-1' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/admin/usage/summary?from=a&to=b&teacherId=teacher-1',
      expect.anything(),
    );

    await getAdminUsageSummary({ from: 'a', to: 'b', teacherId: '  ' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/admin/usage/summary?from=a&to=b',
      expect.anything(),
    );
  });

  it('单教师过滤响应回显 teacherId', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { ...summary, teacherId: 'teacher-1' },
    }));

    const result = await getAdminUsageSummary({ from: 'a', to: 'b', teacherId: 'teacher-1' });
    expect(result.teacherId).toBe('teacher-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('后端错误照常抛 ApiError（VALIDATION_ERROR / DATABASE_NOT_READY）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'from/to 必填', field: 'query' },
    }, 400));

    await expect(getAdminUsageSummary({ from: '', to: '' })).rejects.toBeInstanceOf(ApiError);
    await expect(getAdminUsageSummary({ from: '', to: '' })).rejects.toMatchObject({
      error: { code: 'VALIDATION_ERROR', field: 'query' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'DATABASE_NOT_READY', message: '数据库未就绪' },
    }, 503));
    await expect(getAdminUsageSummary({ from: 'a', to: 'b' })).rejects.toMatchObject({
      error: { code: 'DATABASE_NOT_READY' },
    });
  });
});
