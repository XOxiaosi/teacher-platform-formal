import { Router } from 'express';
import type { Response } from 'express';
import { validationError, type CommonError } from '@teacher-platform/contracts';
import type { AuthService } from '../../features/auth/index.js';
import { createRequireAuth, type AuthenticatedRequest } from '../middleware/require-auth.js';
import type { ProviderConfigService } from '../../features/provider-configs/index.js';

function statusFromError(error: CommonError): number {
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'NOT_FOUND') return 404;
  return 500;
}

function sendError(res: Response, error: CommonError): void {
  res.status(statusFromError(error)).json({ ok: false, error });
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalString(body: unknown, key: string): string | undefined {
  const value = readString(body, key);
  return value === undefined ? undefined : value;
}

function readBoolean(body: unknown, key: string): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function createProviderConfigRouter(
  service: ProviderConfigService,
  authService: AuthService,
): Router {
  const router = Router();
  const requireAuth = createRequireAuth(authService);

  // GET /api/v1/provider-configs — 列表（含 apiKeyMasked + isPrimary，无明文/密文）
  router.get('/provider-configs', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.list(req.teacherId);
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // POST /api/v1/provider-configs — 新增（首条自动 isPrimary）
  router.post('/provider-configs', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.create(req.teacherId, {
      providerKind: readString(req.body, 'providerKind') ?? '',
      providerName: readString(req.body, 'providerName') ?? '',
      displayName: readOptionalString(req.body, 'displayName'),
      baseUrl: readString(req.body, 'baseUrl') ?? '',
      apiKey: readString(req.body, 'apiKey') ?? '',
      model: readString(req.body, 'model') ?? '',
    });
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(201).json({ ok: true, data: result.value });
  });

  // PATCH /api/v1/provider-configs/:id — 更新（apiKey 可更新；isPrimary=true 唯一化）
  router.patch('/provider-configs/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.update(req.teacherId, String(req.params.id), {
      displayName: readOptionalString(req.body, 'displayName'),
      baseUrl: readOptionalString(req.body, 'baseUrl'),
      apiKey: readOptionalString(req.body, 'apiKey'),
      model: readOptionalString(req.body, 'model'),
      status: readOptionalString(req.body, 'status'),
      isPrimary: readBoolean(req.body, 'isPrimary'),
    });
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // DELETE /api/v1/provider-configs/:id — 删除（删 primary 提升其一，无剩余回退默认）
  router.delete('/provider-configs/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.remove(req.teacherId, String(req.params.id));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // POST /api/v1/provider-configs/:id/test — 连通性测试（返回 ProviderError kind，不耗真实业务预算）
  router.post('/provider-configs/:id/test', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.testConnection(req.teacherId, String(req.params.id));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  return router;
}
