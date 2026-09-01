import type { NextFunction, Request, Response } from 'express';
import type { CommonError, Result } from '@teacher-platform/contracts';

export interface AuthenticatedRequest extends Request {
  teacherId?: string;
}

export interface TokenAuthService {
  validateToken(token: string): Promise<Result<{ teacherId: string }, CommonError>>;
}

export function parseSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== 'sessionToken') continue;
    const value = trimmed.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function createRequireAuth(authService: TokenAuthService) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = parseSessionToken(req.headers.cookie);
    if (token) {
      const result = await authService.validateToken(token);
      if (result.ok) {
        (req as AuthenticatedRequest).teacherId = result.value.teacherId;
        next();
        return;
      }
    }
    // 生产禁用 x-teacher-id fallback：production 仅接受 session，缺失或无效时统一 401。
    if (process.env.NODE_ENV !== 'production') {
      const teacherId = req.header('x-teacher-id');
      if (teacherId && teacherId.trim() !== '') {
        (req as AuthenticatedRequest).teacherId = teacherId;
        next();
        return;
      }
    }
    res.status(401).json({ ok: false, error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' } });
  };
}
