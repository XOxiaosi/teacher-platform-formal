import { Router } from 'express';
import { validationError } from '@teacher-platform/contracts';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';
import type { SchedulingWebService, WebFields, WebRuleInput } from '../../features/scheduling-web/scheduling-web-service.js';

/**
 * The preview adapter owns no storage: every command returns a newly read
 * teacher-scoped state document.  `kind` is deliberately closed so a frontend
 * cannot reach old schedule routes with a mismatched payload.
 */
export function createSchedulingWebRouter(service: SchedulingWebService): Router {
  const router = Router();
  router.get('/scheduling-web/state', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    sendResult(res, await service.state(teacher.value));
  });
  router.post('/scheduling-web/commands', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = asObject(req.body); if (!body) return sendTeacherError(res, validationError('请求体必须是对象', 'body'));
    const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId : '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientRequestId)) return sendTeacherError(res, validationError('clientRequestId 格式不合法', 'clientRequestId'));
    const kind = body.kind;
    let result;
    switch (kind) {
      case 'save-schedule': {
        const schedule = fields(body.schedule); if (!schedule) return sendTeacherError(res, validationError('schedule 无效', 'schedule'));
        const before = fields(body.before);
        result = before ? await service.saveOccurrence(teacher.value, before.id!, { ...schedule, clientRequestId, expectedUpdatedAt: expected(body, body.before) }) : await service.saveOnce(teacher.value, { ...schedule, clientRequestId });
        break;
      }
      case 'complete':
        // B02 has not defined how scheduled duration becomes billable lessons.
        // Keep the service implementation internal until that product decision
        // exists; an HTTP command must never infer and deduct a quantity.
        return sendTeacherError(res, validationError('完课自动扣课等待 B02 计费规则确认', 'kind'));
      case 'cancel': case 'restore': {
        const occurrenceId = idOf(body.before); if (!occurrenceId) return sendTeacherError(res, validationError('before.id 必填', 'before'));
        const version = expected(body, asObject(body.before));
        result = kind === 'cancel' ? await service.cancel(teacher.value, occurrenceId, { clientRequestId, expectedUpdatedAt: version }) : await service.restore(teacher.value, occurrenceId, { clientRequestId, expectedUpdatedAt: version });
        break;
      }
      case 'edit-completed': {
        const before = fields(body.before); const schedule = fields(body.schedule);
        if (!before?.id || !schedule) return sendTeacherError(res, validationError('before/schedule 无效', 'body'));
        result = await service.editCompleted(teacher.value, before.id, { ...schedule, clientRequestId, expectedUpdatedAt: expected(body, body.before) });
        break;
      }
      case 'save-rule': {
        const rule = ruleInput(body.rule); if (!rule) return sendTeacherError(res, validationError('rule 无效', 'rule'));
        result = await service.createRule(teacher.value, { ...rule, clientRequestId });
        break;
      }
      case 'replace-rule': {
        const rule = ruleInput(body.rule); if (typeof body.ruleId !== 'string' || typeof body.from !== 'string' || !rule) return sendTeacherError(res, validationError('ruleId/from/rule 无效', 'body'));
        result = await service.replaceRuleFrom(teacher.value, body.ruleId, { fromDate: body.from, rule, clientRequestId, expectedUpdatedAt: expected(body) });
        break;
      }
      case 'end-rule':
        if (typeof body.ruleId !== 'string' || typeof body.from !== 'string') return sendTeacherError(res, validationError('ruleId/from 无效', 'body'));
        result = await service.endRule(teacher.value, body.ruleId, { fromDate: body.from, clientRequestId, expectedUpdatedAt: expected(body) }); break;
      case 'set-rule-enabled':
        if (typeof body.ruleId !== 'string' || typeof body.enabled !== 'boolean') return sendTeacherError(res, validationError('ruleId/enabled 无效', 'body'));
        result = await service.setRuleEnabled(teacher.value, body.ruleId, { enabled: body.enabled, clientRequestId, expectedUpdatedAt: expected(body) }); break;
      default: return sendTeacherError(res, validationError('不支持的排课命令', 'kind'));
    }
    sendResult(res, result);
  });
  return router;
}

function asObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function idOf(value: unknown) { const body = asObject(value); return typeof body?.id === 'string' && body.id ? body.id : undefined; }
function expected(body: Record<string, unknown>, fallback?: unknown) { const source = asObject(fallback); const value = body.expectedUpdatedAt ?? source?.version ?? source?.updatedAt; return typeof value === 'string' ? value : undefined; }
function fields(value: unknown): (WebFields & { id?: string }) | undefined {
  const body = asObject(value); if (!body || typeof body.day !== 'string' || typeof body.start !== 'string' || typeof body.end !== 'string' || typeof body.location !== 'string' || !Array.isArray(body.participants) || !body.participants.every((id) => typeof id === 'string') || (body.format !== '一对一' && body.format !== '小班') || (body.note !== undefined && typeof body.note !== 'string')) return undefined;
  return { ...(typeof body.id === 'string' ? { id: body.id } : {}), day: body.day, start: body.start, end: body.end, location: body.location, participants: body.participants as string[], format: body.format, note: typeof body.note === 'string' ? body.note : '' };
}
function ruleInput(value: unknown): WebRuleInput | undefined {
  const body = asObject(value); const base = fields(body && { ...body, day: body.startDate });
  if (!body || !base || typeof body.startDate !== 'string' || !Array.isArray(body.weekdays) || !body.weekdays.every((day) => typeof day === 'number') || (body.endDate !== undefined && typeof body.endDate !== 'string') || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) return undefined;
  return { startDate: body.startDate, weekdays: body.weekdays as number[], ...(typeof body.endDate === 'string' ? { endDate: body.endDate } : {}), ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}), start: base.start, end: base.end, location: base.location, participants: base.participants, format: base.format, note: base.note };
}
