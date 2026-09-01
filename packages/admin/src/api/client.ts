/**
 * 后台管理前端 API 客户端（packages/admin，独立构建）。
 * 与教师端 client.ts 同风格：信封 {ok,data,error} 解析 + ApiError；
 * admin 请求永远 credentials:'include'（adminToken cookie 由后端 Set-Cookie，前端不存明文）。
 */

const API_BASE = '/api/v1';

interface AdminRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export interface AdminError {
  code: string;
  message: string;
  field?: string;
}

export class ApiError extends Error {
  readonly error: AdminError;
  readonly status: number | null;

  constructor(error: AdminError, status: number | null = null) {
    super(error.message);
    this.name = 'ApiError';
    this.error = error;
    this.status = status;
  }
}

interface ApiResponse<T> {
  ok: true;
  data: T;
}

interface ApiFailure {
  ok: false;
  error: AdminError;
}

/** admin 专用请求：credentials:'include'（adminToken cookie），无 x-teacher-id。 */
export async function adminRequest<T>(path: string, options: AdminRequestOptions = {}): Promise<T> {
  try {
    const response = await fetch(`${API_BASE}${path}`, buildFetchOptions(options));
    const payload = await response.json() as ApiResponse<T> | ApiFailure;

    if (!payload.ok) throw new ApiError(payload.error, response.status);
    return payload.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({ code: 'INTERNAL_ERROR', message: `网络请求失败：${messageOf(error)}` });
  }
}

function buildFetchOptions(options: AdminRequestOptions): RequestInit {
  return {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
