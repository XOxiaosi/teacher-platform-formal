import { Router } from 'express';
import type { Response } from 'express';
import { validationError, type CommonError } from '@teacher-platform/contracts';
import type { AuthService } from '../../features/auth/index.js';
import { createRequireAuth, type AuthenticatedRequest } from '../middleware/require-auth.js';
import type { ProviderUsageService } from '../../features/provider-usage/index.js';

function statusFromError(error: CommonError): number {
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'NOT_FOUND') return 404;
  return 500;
}

function sendError(res: Response, error: CommonError): void {
  res.status(statusFromError(error)).json({ ok: false, error });
}

export function createUsageRouter(service: ProviderUsageService, authService: AuthService): Router {
  const router = Router();
  const requireAuth = createRequireAuth(authService);

  // GET /api/v1/usage/summary?from&to — 按教师聚合（owner 隔离）
  router.get('/usage/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') {
      sendError(res, validationError('from/to 查询参数必填（ISO 时间）', 'query'));
      return;
    }
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      sendError(res, validationError('from/to 必须是合法 ISO 时间且 from < to', 'query'));
      return;
    }
    const summary = await service.summary(req.teacherId, from, to);
    res.status(200).json({ ok: true, data: summary });
  });

  return router;
}
