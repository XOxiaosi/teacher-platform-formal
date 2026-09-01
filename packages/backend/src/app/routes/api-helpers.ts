import type { Request, Response } from 'express';
import { validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { ScheduleType } from '../../features/scheduling/index.js';
import type { AuthenticatedRequest } from '../middleware/require-auth.js';

/**
 * 取当前请求教师身份（P0 修复：IDOR 水平越权，qa3 t11 实测）。
 *
 * 只读 requireAuth 注入的 session 身份（req.teacherId），完全忽略 x-teacher-id 请求头——
 * 攻击者持有效 session 伪造 x-teacher-id 无法以他人身份读写（原实现无条件读 header → 越权）。
 * 未过 requireAuth 的公开路由/测试直调 → req.teacherId 缺失 → 400（错误形状不变）。
 */
export function getTeacherId(req: Request): Result<string, CommonError> {
  const value = (req as AuthenticatedRequest).teacherId;
  if (!value || value.trim() === '') {
    return { ok: false, error: validationError('缺少 teacherId', 'teacherId') };
  }
  return { ok: true, value };
}

export function sendResult<T>(res: Response, result: Result<T, CommonError>, successStatus = 200): void {
  if (result.ok) {
    res.status(successStatus).json({ ok: true, data: result.value });
    return;
  }
  res.status(statusFromError(result.error)).json({ ok: false, error: result.error });
}

export function sendTeacherError(res: Response, error: CommonError): void {
  res.status(statusFromError(error)).json({ ok: false, error });
}

export function readExactEditBody<K extends 'changes' | 'replacement'>(
  body: unknown,
  payloadKey: K,
): Result<Record<'expectedUpdatedAt' | K, never>, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }
  const expectedKeys = new Set(['expectedUpdatedAt', payloadKey]);
  const keys = Object.keys(body);
  if (
    keys.length !== expectedKeys.size
    || keys.some((key) => !expectedKeys.has(key))
    || !Object.hasOwn(body, 'expectedUpdatedAt')
    || !Object.hasOwn(body, payloadKey)
  ) {
    return { ok: false, error: validationError('请求体字段不合法', 'body') };
  }
  return { ok: true, value: body as Record<'expectedUpdatedAt' | K, never> };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function parseNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseScheduleType(value: unknown): Result<ScheduleType | undefined, CommonError> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, error: validationError('日程类型不合法', 'type') };
  }
  switch (value) {
    case 'lesson':
    case 'prep':
    case 'meeting':
    case 'call':
    case 'other':
      return { ok: true, value };
    default:
      return { ok: false, error: validationError('日程类型不合法', 'type') };
  }
}

function statusFromError(error: CommonError): number {
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'PERMISSION_DENIED') return 403;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'ALREADY_CONSUMED') return 409;
  if (error.code === 'VERSION_CONFLICT') return 409;
  return 500;
}
