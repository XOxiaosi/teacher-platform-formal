import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { login, logout, me } from './adminAuth';

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

describe('admin auth api', () => {
  it('login POST /admin/auth/login：credentials:include + body，不带 x-teacher-id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: null }));

    await login({ email: 'admin@example.com', password: 'secret123' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'admin@example.com', password: 'secret123' }),
    });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('headers.x-teacher-id');
  });

  it('logout POST /admin/auth/logout：credentials:include，无 body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: null }));

    await logout();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('me GET /admin/auth/me：200 返回 {email}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { email: 'admin@example.com' },
    }));

    await expect(me()).resolves.toEqual({ email: 'admin@example.com' });
  });

  it('me 401 → null（干净未登录，不抛错）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '未登录' },
    }, 401));

    await expect(me()).resolves.toBeNull();
  });

  it('me 网络失败抛 INTERNAL_ERROR ApiError（区别于 401 匿名）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(me()).rejects.toMatchObject({
      name: 'ApiError',
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('登录失败（401 凭据错误）抛 ApiError 携带错误信封', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '邮箱或密码错误' },
    }, 401));

    await expect(login({ email: 'a@b.com', password: 'wrong' })).rejects.toBeInstanceOf(ApiError);
  });
});
