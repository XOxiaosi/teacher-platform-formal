import { ApiError, adminRequest } from './client';

/**
 * 管理员认证 API（p7-admin-panel-design.md §3.2 阶段一 env 版）：
 * - POST /api/v1/admin/auth/login    {email,password} → 200 Set-Cookie adminToken
 * - POST /api/v1/admin/auth/logout   清 cookie，幂等
 * - GET  /api/v1/admin/auth/me       → 200 {email} | 401
 * adminToken cookie 由后端 Set-Cookie（HttpOnly），前端不存明文。
 */

export interface AdminMeData {
  email: string;
}

export interface AdminLoginCredentials {
  email: string;
  password: string;
}

/** POST /api/v1/admin/auth/login → Set-Cookie adminToken。 */
export function login(credentials: AdminLoginCredentials): Promise<void> {
  return adminRequest<void>('/admin/auth/login', { method: 'POST', body: credentials });
}

/** POST /api/v1/admin/auth/logout → 清 cookie（幂等）。 */
export function logout(): Promise<void> {
  return adminRequest<void>('/admin/auth/logout', { method: 'POST' });
}

/** GET /api/v1/admin/auth/me → 200 {email} | 401 → null（干净未登录）。 */
export async function me(): Promise<AdminMeData | null> {
  try {
    return await adminRequest<AdminMeData>('/admin/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}
