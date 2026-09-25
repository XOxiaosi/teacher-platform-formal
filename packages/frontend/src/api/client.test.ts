import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiDownloadBlob, apiRequest, onSessionExpired } from './client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiRequest', () => {
  it('网关返回空白或非 JSON 错误时保留状态且不泄露解析异常', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected end of JSON'); } } as unknown as Response);
    await expect(apiRequest('/students', {})).rejects.toMatchObject({ status: 502, message: '服务暂时不可用，请稍后重试。' });
  });
  it('HTTP 失败不接受伪装成功的响应体', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 500, ok: false, json: async () => ({ ok: true, data: {} }) } as Response);
    await expect(apiRequest('/students', {})).rejects.toMatchObject({ status: 500, message: '服务暂时不可用，请稍后重试。' });
  });
  it('发送 JSON 请求并返回 data；不再携带 x-teacher-id 头（身份唯一来源为 session cookie）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { id: 'student-1' } }),
    } as Response);

    const result = await apiRequest<{ id: string }>('/students', {
      method: 'POST',
      teacherId: 'demo-teacher',
      body: { name: '张三' },
    });

    expect(result).toEqual({ id: 'student-1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/students', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ name: '张三' }),
    });
  });

  it('后端返回 ok:false 时抛出 ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: { code: 'VALIDATION_ERROR', message: '缺少 teacherId', field: 'teacherId' } }),
    } as Response);

    await expect(apiRequest('/students', { method: 'POST', teacherId: '', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      error: { code: 'VALIDATION_ERROR', message: '缺少 teacherId', field: 'teacherId' },
    });
  });

  it('网络失败时抛出 INTERNAL_ERROR ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(apiRequest('/students', { teacherId: 'demo-teacher' })).rejects.toBeInstanceOf(ApiError);
    await expect(apiRequest('/students', { teacherId: 'demo-teacher' })).rejects.toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: '网络请求失败：network down' },
    });
  });
});

describe('apiDownloadBlob（P14 t5 二进制附件下载）', () => {
  it('GET 下载返回 blob + content-disposition（不解析 JSON；credentials include）', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/zip',
        'content-disposition': "attachment; filename*=UTF-8''export-t1.zip",
      }),
      blob: async () => new Blob([bytes], { type: 'application/zip' }),
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);

    const result = await apiDownloadBlob('/privacy/export/download?jobId=job_1');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/privacy/export/download?jobId=job_1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
    expect(result.contentDisposition).toContain('export-t1.zip');
    expect(result.blob.type).toBe('application/zip');
    expect(result.blob.size).toBe(bytes.length);
  });

  it('非 2xx：后端 JSON 错误体 → ApiError（携带 code/status）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '导出产物不存在' } }),
    } as unknown as Response);

    await expect(apiDownloadBlob('/privacy/export/download?jobId=job_nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      error: { code: 'NOT_FOUND', message: '导出产物不存在' },
    });
  });

  it('401 → 触发会话过期回调 + ApiError；网络失败 → INTERNAL_ERROR', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: '会话无效或已过期' } }),
      } as unknown as Response);
      await expect(apiDownloadBlob('/privacy/export/download?jobId=job_1')).rejects.toMatchObject({
        status: 401,
        error: { code: 'PERMISSION_DENIED' },
      });
      expect(expired).toHaveBeenCalledTimes(1);

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
      await expect(apiDownloadBlob('/privacy/export/download?jobId=job_2')).rejects.toMatchObject({
        error: { code: 'INTERNAL_ERROR', message: '网络请求失败：network down' },
      });
    } finally {
      off();
    }
  });
});
