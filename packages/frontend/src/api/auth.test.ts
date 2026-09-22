import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authRequest, apiRequest, onSessionExpired } from './client';
import { acceptInvitation, login, logout, me } from './auth';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe('auth api', () => {
  it('acceptInvitation 打邀请接受接口且不带邮箱', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: null }, 201));

    await acceptInvitation({ token: 'invite-1', password: 'password123', displayName: '张三' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: 'invite-1', password: 'password123', displayName: '张三' }),
    });
  });

  it('login 打 /auth/login，credentials:include 且不带 x-teacher-id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: null }));

    await login({ email: 'a@b.com', password: 'password123' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'a@b.com', password: 'password123' }),
    });
  });

  it('logout 打 /auth/logout 且无 body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: null }));

    await logout();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('me 200 返回身份', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { id: 'teacher-1', email: 'a@b.com', displayName: '张三' },
    }));

    await expect(me()).resolves.toEqual({ id: 'teacher-1', email: 'a@b.com', displayName: '张三' });
  });

  it('me 401 返回 null（不抛错）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '未登录' },
    }, 401));

    await expect(me()).resolves.toBeNull();
  });

  it('me 网络失败抛 INTERNAL_ERROR（区别于 401 匿名）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(me()).rejects.toMatchObject({
      name: 'ApiError',
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});

describe('authRequest / apiRequest 关系', () => {
  it('authRequest 与 apiRequest 都带 credentials:include', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: { x: 1 } }));

    await authRequest('/auth/me');
    await apiRequest('/students', { teacherId: 't1' });

    const calls = fetchMock.mock.calls;
    expect(calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(calls[1][1]).toMatchObject({ credentials: 'include' });
  });

  it('authRequest 与 apiRequest 都不携带 x-teacher-id（身份唯一来源为 session cookie）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: { x: 1 } }));

    await authRequest('/auth/me');
    await apiRequest('/students', { teacherId: 't1' });

    const firstHeaders = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    const secondHeaders = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(firstHeaders.headers).toEqual({ 'content-type': 'application/json' });
    expect(secondHeaders.headers).toEqual({ 'content-type': 'application/json' });
    expect(firstHeaders).not.toHaveProperty('headers.x-teacher-id');
    expect(secondHeaders).not.toHaveProperty('headers.x-teacher-id');
  });

  it('业务 401 触发 onSessionExpired 全局回调且照常抛 ApiError（不吞异常）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '会话过期' },
    }, 401));

    const handler = vi.fn();
    const unregister = onSessionExpired(handler);

    await expect(apiRequest('/students', { teacherId: 't1' })).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    unregister();
  });
});
