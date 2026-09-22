import type { RequestHandler, Response, Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { validationError, type CommonError } from '@teacher-platform/contracts';
import type { AdminRequest } from '../../shared/http-admin-auth/index.js';
import {
  createTeacherInvitation,
  listTeacherInvitations,
  revokeTeacherInvitation,
  setTeacherStatus,
} from './admin-actions.js';
import type { AdminAuditInput } from './audit.js';

type IdentityRegistryPrisma = Pick<
  PrismaClient,
  'teacherRegistry' | 'teacherInvitation' | 'sessionStore' | '$transaction' | '$queryRaw'
>;

export interface AdminIdentityRouteOptions {
  router: Router;
  requireAdmin: RequestHandler;
  registryPrisma: IdentityRegistryPrisma;
  audit: (req: AdminRequest, input: AdminAuditInput) => Promise<void>;
}

function statusFromAdminError(error: CommonError): number {
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'ALREADY_CONSUMED' || error.code === 'VERSION_CONFLICT') return 409;
  return 500;
}

function sendAdminError(res: Response, error: CommonError): void {
  res.status(statusFromAdminError(error)).json({ ok: false, error });
}

function readStringBody(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** T-014 最小管理面：邀请教师自己设定密码，以及停用/启用账号。 */
export function registerAdminIdentityRoutes(options: AdminIdentityRouteOptions): void {
  const { router, requireAdmin, registryPrisma, audit } = options;

  // 创建一次性邀请；token 仅在本响应中返回，管理员不能代设密码。
  router.post('/invitations', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    const email = readStringBody(req.body, 'email');
    const rawHours = (req.body as Record<string, unknown> | null | undefined)?.expiresInHours;
    const expiresInHours = rawHours === undefined
      ? undefined
      : typeof rawHours === 'number' && Number.isFinite(rawHours)
        ? rawHours
        : undefined;
    if (
      email === undefined
      || (rawHours !== undefined && (typeof rawHours !== 'number' || !Number.isFinite(rawHours)))
    ) {
      const error = validationError('请求体必须包含 email；expiresInHours 必须为数字', 'body');
      await audit(req, { actor, action: 'invitation.create', objectType: 'invitation', error });
      sendAdminError(res, error);
      return;
    }
    const result = await createTeacherInvitation(registryPrisma, { email, expiresInHours });
    if (!result.ok) {
      await audit(req, { actor, action: 'invitation.create', objectType: 'invitation', error: result.error });
      sendAdminError(res, result.error);
      return;
    }
    await audit(req, {
      actor,
      action: 'invitation.create',
      objectType: 'invitation',
      objectId: result.value.invitation.id,
    });
    res.status(201).json({ ok: true, data: result.value });
  });

  // 列表不含 tokenHash / 原始 token。
  router.get('/invitations', requireAdmin, async (_req: AdminRequest, res) => {
    const result = await listTeacherInvitations(registryPrisma);
    if (!result.ok) {
      sendAdminError(res, result.error);
      return;
    }
    const invitations = result.value.map((invitation) => ({
      ...invitation,
      status: invitation.status === 'accepted' ? 'consumed' as const : invitation.status,
    }));
    res.status(200).json({ ok: true, data: { items: invitations } });
  });

  // 已接受/已撤销邀请不可重写。
  router.post('/invitations/:id/revoke', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    const invitationId = String(req.params.id);
    const result = await revokeTeacherInvitation(registryPrisma, invitationId);
    if (!result.ok) {
      await audit(req, {
        actor,
        action: 'invitation.revoke',
        objectType: 'invitation',
        objectId: invitationId,
        error: result.error,
      });
      sendAdminError(res, result.error);
      return;
    }
    await audit(req, { actor, action: 'invitation.revoke', objectType: 'invitation', objectId: invitationId });
    res.status(200).json({ ok: true, data: { invitation: result.value } });
  });

  // 停用后服务层在同一事务中删除该教师所有 session。
  router.patch('/teachers/:id/status', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    const status = readStringBody(req.body, 'status');
    if (status !== 'active' && status !== 'disabled') {
      const error = validationError('status 只能是 active|disabled', 'status');
      await audit(req, {
        actor,
        action: 'teacher.status',
        objectType: 'teacher',
        objectId: String(req.params.id),
        error,
      });
      sendAdminError(res, error);
      return;
    }
    const result = await setTeacherStatus(registryPrisma, String(req.params.id), status);
    const action = status === 'disabled' ? 'teacher.disable' : 'teacher.enable';
    if (!result.ok) {
      await audit(req, {
        actor,
        action,
        objectType: 'teacher',
        objectId: String(req.params.id),
        error: result.error,
      });
      sendAdminError(res, result.error);
      return;
    }
    await audit(req, { actor, action, objectType: 'teacher', objectId: result.value.id });
    res.status(200).json({ ok: true, data: { teacher: result.value } });
  });
}
