import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  deactivate,
  exportDownload,
  exportDownloadZip,
  exportPrivacy,
  exportStatus,
  parseAttachmentFilename,
} from './privacy';

function mockSuccess<T>(data: T) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  } as Response);
}

function mockFailure(error: { code: string; message: string; field?: string }, status = 400) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ ok: false, error }),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('privacy API client（契约 backend privacy.routes：导出 jobId 轮询下载 + 注销双验证）', () => {
  it('exportPrivacy 发 POST /api/v1/privacy/export，无 body、不带任何教师标识（零越权，owner 由后端 session 保证）', async () => {
    const fetchMock = mockSuccess({ jobId: 'job_abc123' });

    await expect(exportPrivacy()).resolves.toEqual({ jobId: 'job_abc123' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/privacy/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
    // 零越权：请求头不含 x-teacher-id，URL 不含 teacherId
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toMatch(/teacher/i);
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/x-teacher-id/i);
    expect(init.body).toBeUndefined();
  });

  it('P14 t5：exportPrivacy({format:"zip"}) 发 POST body {format:"zip"}（zip 单包任务）', async () => {
    const fetchMock = mockSuccess({ jobId: 'job_zip1' });

    await expect(exportPrivacy({ format: 'zip' })).resolves.toEqual({ jobId: 'job_zip1' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ format: 'zip' });
    // 零越权：body 不含 teacherId/任何他人标识
    expect(JSON.parse(String(init.body))).not.toHaveProperty('teacherId');
  });

  it('P6-READABLE：exportPrivacy({format:"readable"}) 请求可读完整 ZIP', async () => {
    const fetchMock = mockSuccess({ jobId: 'job_readable1' });
    await expect(exportPrivacy({ format: 'readable' })).resolves.toEqual({ jobId: 'job_readable1' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ format: 'readable' });
  });

  it('exportStatus 发 GET /api/v1/privacy/export/status?jobId=（URL 编码，不带教师标识）', async () => {
    const fetchMock = mockSuccess({ jobId: 'job_1', status: 'running' });

    await expect(exportStatus('job_1')).resolves.toEqual({ jobId: 'job_1', status: 'running' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/privacy/export/status?jobId=job_1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
    expect(fetchMock.mock.calls[0][0]).not.toMatch(/teacher/i);
  });

  it('exportDownload 发 GET /api/v1/privacy/export/download?jobId= 并返回 {manifest,account,tables}', async () => {
    const data = {
      manifest: { generatedAt: '2026-08-01T00:00:00.000Z' },
      account: { email: 'demo@example.com' },
      tables: { students: [{ id: 's1', name: '张三' }] },
    };
    const fetchMock = mockSuccess(data);

    await expect(exportDownload('job_1')).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/privacy/export/download?jobId=job_1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('P14 t5：exportDownloadZip 发 GET download?jobId= 并返回 blob + Content-Disposition 文件名（zip 单包）', async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/zip',
        'content-disposition': "attachment; filename*=UTF-8''export-demo-teacher.zip",
      }),
      blob: async () => new Blob([zipBytes], { type: 'application/zip' }),
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);

    const result = await exportDownloadZip('job_zip1');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/privacy/export/download?jobId=job_zip1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
    expect(result.filename).toBe('export-demo-teacher.zip');
    expect(result.blob.type).toBe('application/zip');
    expect(result.blob.size).toBe(zipBytes.length);
  });

  it('P14 t5：exportDownloadZip 非 2xx（404 NOT_FOUND）→ ApiError；Content-Disposition 缺失 → filename=null', async () => {
    // 404：后端错误体为 JSON {ok:false,error}
    mockFailure({ code: 'NOT_FOUND', message: '导出产物不存在' }, 404);
    await expect(exportDownloadZip('job_nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      error: { code: 'NOT_FOUND' },
    });

    // 200 但无 content-disposition → filename null（页面兜底 export-<teacherId>.zip）
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/zip' }),
      blob: async () => new Blob(['x'], { type: 'application/zip' }),
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);
    const result = await exportDownloadZip('job_zip2');
    expect(result.filename).toBeNull();
  });

  it('parseAttachmentFilename：UTF-8 filename* 解析 / 无编码 filename / 缺失 / 非法编码', () => {
    expect(parseAttachmentFilename("attachment; filename*=UTF-8''export-cmt123.zip")).toBe('export-cmt123.zip');
    expect(parseAttachmentFilename("attachment; filename*=UTF-8''export-%E4%B8%AD%E6%96%87.zip")).toBe('export-中文.zip');
    expect(parseAttachmentFilename('attachment; filename=export-x.zip')).toBeNull();
    expect(parseAttachmentFilename(null)).toBeNull();
    expect(parseAttachmentFilename("attachment; filename*=UTF-8''%E4%B8%8D%E5%AE%8C%E6%95%B4%")).toBeNull(); // 非法 % 序列
  });

  it('deactivate 发 POST /api/v1/privacy/deactivate，body 仅 {email,password,confirm}（不附加 teacherId）', async () => {
    const fetchMock = mockSuccess({ jobId: 'job_d1', status: 'succeeded' });

    await expect(deactivate({
      email: 'demo@example.com',
      password: 'secret',
      confirm: 'demo@example.com',
    })).resolves.toEqual({ jobId: 'job_d1', status: 'succeeded' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/privacy/deactivate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'demo@example.com', password: 'secret', confirm: 'demo@example.com' }),
    });
    // 零越权：body 不含 teacherId/任何他人标识
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('teacherId');
  });

  it('注销错误分支：400 VALIDATION_ERROR（邮箱/密码/confirm）抛 ApiError 带 status 与 field', async () => {
    const cases: Array<{ field: string; message: string }> = [
      { field: 'email', message: '邮箱与当前账号不匹配' },
      { field: 'password', message: '邮箱或密码错误' },
      { field: 'confirm', message: '二次确认不匹配（需输入邮箱或确认短语）' },
    ];
    for (const item of cases) {
      mockFailure({ code: 'VALIDATION_ERROR', message: item.message, field: item.field }, 400);
      await expect(deactivate({
        email: 'demo@example.com',
        password: 'bad',
        confirm: 'bad',
      })).rejects.toMatchObject({
        name: 'ApiError',
        status: 400,
        error: { code: 'VALIDATION_ERROR', field: item.field, message: item.message },
      });
      vi.restoreAllMocks();
    }
  });

  it('429 限流：RATE_LIMITED 抛 ApiError status=429，code=RATE_LIMITED', async () => {
    mockFailure({ code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试', field: 'rate' }, 429);

    await expect(deactivate({
      email: 'demo@example.com',
      password: 'secret',
      confirm: 'demo@example.com',
    })).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      error: { code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试' },
    });
  });

  it('导出端点 404（jobId 不存在/他人）→ ApiError status=404 NOT_FOUND', async () => {
    mockFailure({ code: 'NOT_FOUND', message: '任务不存在' }, 404);
    await expect(exportStatus('job_nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      error: { code: 'NOT_FOUND' },
    });

    mockFailure({ code: 'NOT_FOUND', message: '任务不存在' }, 404);
    await expect(exportDownload('job_nope')).rejects.toBeInstanceOf(ApiError);
  });
});
