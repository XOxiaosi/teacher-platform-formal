import { ApiError, authRequest } from './client';

export interface MeData {
  id: string;
  email: string;
  displayName: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginCredentials {
  displayName: string;
}

/** POST /api/v1/auth/register → 201 Set-Cookie sessionToken */
export function register(input: RegisterInput): Promise<void> {
  return authRequest<void>('/auth/register', { method: 'POST', body: input });
}

/** POST /api/v1/auth/login → 200 Set-Cookie sessionToken */
export function login(credentials: LoginCredentials): Promise<void> {
  return authRequest<void>('/auth/login', { method: 'POST', body: credentials });
}

/** POST /api/v1/auth/logout → 200 清 cookie */
export function logout(): Promise<void> {
  return authRequest<void>('/auth/logout', { method: 'POST' });
}

/** GET /api/v1/auth/me → 200 {id,email,displayName} | 401 → null */
export async function me(): Promise<MeData | null> {
  try {
    return await authRequest<MeData>('/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}
