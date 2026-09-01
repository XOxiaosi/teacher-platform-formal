import type { NextFunction, Request, Response } from 'express';
import type { CommonError, Result } from '@teacher-platform/contracts';

export interface AdminRequest extends Request {
  admin?: { email: string };
}

export interface AdminTokenAuthService {
  validateToken(token: string): Promise<Result<{ email: string }, CommonError>>;
}

export function parseAdminToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== 'adminToken') continue;
    const value = trimmed.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function createRequireAdmin(adminAuth: AdminTokenAuthService) {
  return async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = parseAdminToken(req.headers.cookie);
    if (token) {
      const result = await adminAuth.validateToken(token);
      if (result.ok) {
        (req as AdminRequest).admin = { email: result.value.email };
        next();
        return;
      }
    }
    res.status(401).json({ ok: false, error: { code: 'PERMISSION_DENIED', message: '管理员未登录或会话已过期' } });
  };
}
