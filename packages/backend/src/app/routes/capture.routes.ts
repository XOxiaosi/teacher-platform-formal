import { Router } from 'express';
import { err, validationError } from '@teacher-platform/contracts';
import type { CaptureRouteDependencies } from '../composition/types.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';

function textBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(validationError('请求体必须是对象', 'body'));
  const value = body as Record<string, unknown>;
  if (value.sourceType !== 'text') return err(validationError('当前仅支持网页文字记录', 'sourceType'));
  if (typeof value.clientRequestId !== 'string' || typeof value.text !== 'string') return err(validationError('请求体字段不合法', 'body'));
  if (value.candidates !== undefined && (!Array.isArray(value.candidates) || value.candidates.length === 0 || value.candidates.some(item => !item || typeof item !== 'object' || typeof item.text !== 'string'))) return err(validationError('候选格式不合法', 'candidates'));
  return { ok: true as const, value: { clientRequestId: value.clientRequestId, text: value.text, ...(value.candidates === undefined ? {} : { candidates: (value.candidates as { text: string }[]).map(item => ({ text: item.text })) }) } };
}
function deletionBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).clientRequestId !== 'string') return err(validationError('clientRequestId 必填', 'clientRequestId'));
  return { ok: true as const, value: { clientRequestId: (body as Record<string, string>).clientRequestId } };
}
function confirmRecordBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(validationError('请求体必须是对象', 'body'));
  const value = body as Record<string, unknown>;
  if (typeof value.clientRequestId !== 'string' || typeof value.studentId !== 'string') {
    return err(validationError('clientRequestId 与 studentId 必填', 'body'));
  }
  if (value.scheduleId !== undefined && typeof value.scheduleId !== 'string') return err(validationError('scheduleId 格式不合法', 'scheduleId'));
  return { ok: true as const, value: { clientRequestId: value.clientRequestId, studentId: value.studentId, scheduleId: value.scheduleId as string | undefined } };
}
export function createCaptureRouter(dependencies: CaptureRouteDependencies): Router {
  const router = Router();
  router.post('/captures', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = textBody(req.body); if (!body.ok) return sendTeacherError(res, body.error);
    const result = await dependencies.capture.createText({ teacherId: teacher.value, ...body.value });
    sendResult(res, result, result.ok && result.value.replayed ? 200 : 201);
  });
  router.get('/captures/:eventId', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    sendResult(res, await dependencies.capture.get({ teacherId: teacher.value, eventId: req.params.eventId }));
  });
  router.post('/captures/:eventId/confirm-record', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = confirmRecordBody(req.body); if (!body.ok) return sendTeacherError(res, body.error);
    const result = await dependencies.capture.confirmRecord({ teacherId: teacher.value, eventId: req.params.eventId, ...body.value });
    sendResult(res, result, result.ok && result.value.replayed ? 200 : 201);
  });
  router.post('/captures/:eventId/deletions', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = deletionBody(req.body); if (!body.ok) return sendTeacherError(res, body.error);
    const result = await dependencies.capture.requestDeletion({ teacherId: teacher.value, eventId: req.params.eventId, ...body.value });
    sendResult(res, result, result.ok && result.value.replayed ? 200 : 202);
  });
  router.get('/capture-deletions/:receiptId', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    sendResult(res, await dependencies.capture.getDeletionReceipt({ teacherId: teacher.value, receiptId: req.params.receiptId }));
  });
  router.post('/capture-deletions/:receiptId/retry', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.capture.retryDeletion({ teacherId: teacher.value, receiptId: req.params.receiptId });
    sendResult(res, result, result.ok && result.value.replayed ? 200 : 202);
  });
  router.get('/captures', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if ((req.query.cursor !== undefined && typeof req.query.cursor !== 'string') || (req.query.limit !== undefined && typeof req.query.limit !== 'string')) return sendTeacherError(res, validationError('分页参数不合法', 'query'));
    sendResult(res, await dependencies.capture.list({ teacherId: teacher.value, cursor: req.query.cursor as string | undefined, limit: req.query.limit === undefined ? undefined : Number(req.query.limit) }));
  });
  router.patch('/captures/:eventId/candidates/:candidateId', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (!req.body || !Number.isSafeInteger(req.body.version) || typeof req.body.text !== 'string') return sendTeacherError(res, validationError('候选版本与文字必填', 'body'));
    sendResult(res, await dependencies.capture.editCandidate({ teacherId: teacher.value, eventId: req.params.eventId, candidateId: req.params.candidateId, version: req.body.version, text: req.body.text }));
  });
  router.post('/captures/:eventId/candidates/:candidateId/review', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (!req.body || !Number.isSafeInteger(req.body.version) || !['reject', 'defer'].includes(req.body.action)) return sendTeacherError(res, validationError('核对操作与版本不合法', 'body'));
    sendResult(res, await dependencies.capture.reviewCandidate({ teacherId: teacher.value, eventId: req.params.eventId, candidateId: req.params.candidateId, version: req.body.version, action: req.body.action }));
  });
  router.post('/captures/:eventId/candidates/:candidateId/confirm-record', async (req, res) => {
    const teacher = getTeacherId(req); if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = confirmRecordBody(req.body); if (!body.ok) return sendTeacherError(res, body.error);
    if (!Number.isSafeInteger(req.body.version) || req.body.version < 1) return sendTeacherError(res, validationError('候选版本必填', 'version'));
    const result = await dependencies.capture.confirmRecord({ teacherId: teacher.value, eventId: req.params.eventId, candidateId: req.params.candidateId, version: req.body.version, ...body.value });
    sendResult(res, result, result.ok && result.value.replayed ? 200 : 201);
  });
  return router;
}
