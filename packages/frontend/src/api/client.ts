import type { ApiResponse, CommonError } from './types';

const API_BASE = '/api/v1';

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * 调用方教师（owner 意图标注，不再随请求头发送）。
   * t14 IDOR 修复后后端业务身份唯一来源为 session cookie（requireAuth → req.teacherId），
   * x-teacher-id 请求头已下线（仅剩非生产 dev fallback，生产 401 强制 session）。
   */
  teacherId?: string;
  body?: unknown;
}

interface AuthRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  credentials?: RequestCredentials;
}

export class ApiError extends Error {
  readonly error: CommonError;
  readonly status: number | null;

  constructor(error: CommonError, status: number | null = null) {
    super(error.message);
    this.name = 'ApiError';
    this.error = error;
    this.status = status;
  }
}

type SessionExpiredHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;

/** 注册全局会话过期回调（TeacherProvider 挂载时调用）；不吞 ApiError。返回注销函数。 */
export function onSessionExpired(handler: SessionExpiredHandler): () => void {
  sessionExpiredHandler = handler;
  return () => {
    if (sessionExpiredHandler === handler) sessionExpiredHandler = null;
  };
}

/** 业务请求：credentials:'include'（session cookie 是唯一身份来源；不再附加 x-teacher-id 头）。 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions): Promise<T> {
  return fetchJson<T>(path, {
    method: options.method,
    body: options.body,
    credentials: 'include',
  });
}

/** auth 专用请求：credentials:'include'，与业务请求同构（均不携带 x-teacher-id）。 */
export async function authRequest<T>(path: string, options: AuthRequestOptions = {}): Promise<T> {
  return fetchJson<T>(path, {
    method: options.method,
    body: options.body,
    credentials: 'include',
  });
}

/** 二进制附件下载（P14 t5 zip 导出等）：GET + credentials:'include'；
 *  401 触发会话过期回调；非 2xx 时后端返回 JSON {ok:false,error} → 解析为 ApiError。 */
export async function apiDownloadBlob(path: string): Promise<{ blob: Blob; contentDisposition: string | null }> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });

    if (response.status === 401) {
      sessionExpiredHandler?.();
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null) as ApiResponse<unknown> | null;
      if (payload && !payload.ok) throw new ApiError(payload.error, response.status);
      throw new ApiError(
        { code: 'INTERNAL_ERROR', message: `下载失败（HTTP ${response.status}）` },
        response.status,
      );
    }

    const blob = await response.blob();
    return { blob, contentDisposition: response.headers.get('content-disposition') };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({ code: 'INTERNAL_ERROR', message: `网络请求失败：${messageOf(error)}` });
  }
}

async function fetchJson<T>(path: string, options: FetchJsonOptions): Promise<T> {
  try {
    const response = await fetch(`${API_BASE}${path}`, buildFetchOptions(options));

    if (response.status === 401) {
      sessionExpiredHandler?.();
    }

    const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
    if (!payload || typeof payload.ok !== 'boolean' || (payload.ok && response.ok === false)) {
      throw new ApiError({ code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }, response.status);
    }

    if (!payload.ok) throw new ApiError(payload.error, response.status);
    return payload.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({ code: 'INTERNAL_ERROR', message: `网络请求失败：${messageOf(error)}` });
  }
}

function buildFetchOptions(options: FetchJsonOptions): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  return {
    method: options.method ?? 'GET',
    headers,
    credentials: options.credentials,
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
