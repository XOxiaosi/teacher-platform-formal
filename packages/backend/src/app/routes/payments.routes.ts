import { Router } from 'express';
import type { PaymentRouteDependencies } from '../composition/types.js';
import { validationError } from '@teacher-platform/contracts';
import { getTeacherId, parseDate, sendResult, sendTeacherError } from './api-helpers.js';

const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
  ) return undefined;

  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parsePositiveIntegerQuery(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePaymentQueryDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  const match = ISO_DATE_PATTERN.exec(normalized);
  if (!match) return parseIsoInstant(normalized);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return undefined;
  return new Date(`${normalized}T00:00:00.000Z`);
}

type AdjustmentRequestBody = {
  studentId: string;
  entryType: 'refund' | 'gift' | 'manual_adjustment';
  lessonDelta: number;
  reason: string;
  clientRequestId: string;
};

type LessonStatusCorrectionRequestBody = {
  lessonId: string;
  targetStatus: 'attended' | 'absent';
  reason: string;
  clientRequestId: string;
};

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_CORRECTION_REASON_LENGTH = 500;

function parseLessonStatusCorrectionRequestBody(body: unknown): { ok: true; value: LessonStatusCorrectionRequestBody } | { ok: false; error: ReturnType<typeof validationError> } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: validationError('请求体必须是对象', 'body') };
  const value = body as Record<string, unknown>;
  const lessonId = typeof value.lessonId === 'string' ? value.lessonId.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  const clientRequestId = typeof value.clientRequestId === 'string' ? value.clientRequestId.trim() : '';
  if (!lessonId) return { ok: false, error: validationError('lessonId 必填', 'lessonId') };
  if (value.targetStatus !== 'attended' && value.targetStatus !== 'absent') return { ok: false, error: validationError('targetStatus 仅支持 attended 或 absent', 'targetStatus') };
  if (!reason || reason.length > MAX_CORRECTION_REASON_LENGTH) return { ok: false, error: validationError('更正原因必填且不能超过 500 个字符', 'reason') };
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) return { ok: false, error: validationError('clientRequestId 格式无效', 'clientRequestId') };
  return { ok: true, value: { lessonId, targetStatus: value.targetStatus, reason, clientRequestId } };
}

function parseAdjustmentRequestBody(body: unknown): { ok: true; value: AdjustmentRequestBody } | { ok: false; error: ReturnType<typeof validationError> } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }
  const value = body as Record<string, unknown>;
  if (typeof value.studentId !== 'string' || !value.studentId.trim()) {
    return { ok: false, error: validationError('studentId 必填', 'studentId') };
  }
  if (value.entryType !== 'refund' && value.entryType !== 'gift' && value.entryType !== 'manual_adjustment') {
    return { ok: false, error: validationError('不支持的账本类型', 'entryType') };
  }
  if (
    typeof value.lessonDelta !== 'number'
    || !Number.isSafeInteger(value.lessonDelta)
    || value.lessonDelta === 0
    || value.lessonDelta < -2_147_483_648
    || value.lessonDelta > 2_147_483_647
  ) {
    return { ok: false, error: validationError('课时调整必须是非零整数', 'lessonDelta') };
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) {
    return { ok: false, error: validationError('调整原因必填', 'reason') };
  }
  if (typeof value.clientRequestId !== 'string' || !value.clientRequestId.trim()) {
    return { ok: false, error: validationError('clientRequestId 必填', 'clientRequestId') };
  }
  return {
    ok: true,
    value: {
      studentId: value.studentId.trim(),
      entryType: value.entryType,
      lessonDelta: value.lessonDelta,
      reason: value.reason.trim(),
      clientRequestId: value.clientRequestId.trim(),
    },
  };
}

export function createPaymentRouter(dependencies: PaymentRouteDependencies): Router {
  const router = Router();

  router.get('/payments', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const studentIdRaw = req.query.studentId;
    if (
      studentIdRaw !== undefined
      && (typeof studentIdRaw !== 'string' || !studentIdRaw.trim())
    ) {
      return sendTeacherError(
        res,
        validationError('studentId 必须是非空字符串', 'studentId'),
      );
    }
    const studentId = typeof studentIdRaw === 'string' ? studentIdRaw.trim() : undefined;

    const paidAtFromRaw = req.query.paidAtFrom;
    const paidAtToRaw = req.query.paidAtTo;
    const paidAtFrom = parsePaymentQueryDate(paidAtFromRaw);
    const paidAtTo = parsePaymentQueryDate(paidAtToRaw);
    const pageRaw = req.query.page;
    const pageSizeRaw = req.query.pageSize;
    const page = parsePositiveIntegerQuery(pageRaw);
    const pageSize = parsePositiveIntegerQuery(pageSizeRaw);
    if (
      (paidAtFromRaw !== undefined && !paidAtFrom)
      || (paidAtToRaw !== undefined && !paidAtTo)
      || (paidAtFrom && paidAtTo && paidAtFrom > paidAtTo)
      || (pageRaw !== undefined && page === undefined)
      || (pageSizeRaw !== undefined && pageSize === undefined)
    ) {
      return sendTeacherError(
        res,
        validationError('缴费查询参数不合法', 'query'),
      );
    }
    const result = await dependencies.payments.listPayments({
      teacherId: teacher.value,
      studentId,
      paidAtFrom,
      paidAtTo,
      page,
      pageSize,
    });
    sendResult(res, result);
  });

  router.post('/payments', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (typeof req.body?.clientRequestId !== 'string' || !req.body.clientRequestId.trim()) {
      return sendTeacherError(res, validationError('clientRequestId 必填', 'clientRequestId'));
    }
    const result = await dependencies.payments.createPayment({
      teacherId: teacher.value,
      clientRequestId: req.body.clientRequestId.trim(),
      studentId: req.body.studentId,
      amount: Number(req.body.amount),
      lessonCount: Number(req.body.lessonCount),
      paidAt: parseDate(req.body.paidAt) as Date,
      note: req.body.note,
    });
    sendResult(res, result, 201);
  });

  // 人工影响课时余额的操作必须经过两步：先写待确认请求，再明确确认写不可变流水。
  router.post('/lesson-ledger/adjustments', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = parseAdjustmentRequestBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);
    const result = await dependencies.ledger.prepareAdjustment({
      teacherId: teacher.value,
      ...body.value,
    });
    sendResult(res, result, 201);
  });

  // Attendance correction is intentionally independent from ordinary schedule
  // editing. This endpoint only persists the pending confirmation and audit.
  router.post('/lesson-status-corrections', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const body = parseLessonStatusCorrectionRequestBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);
    const result = await dependencies.lessonStatusCorrections.prepareLessonStatusCorrection({ teacherId: teacher.value, ...body.value });
    sendResult(res, result, 201);
  });

  router.get('/lesson-ledger/entries', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const studentIdRaw = req.query.studentId;
    if (
      studentIdRaw !== undefined
      && (typeof studentIdRaw !== 'string' || !studentIdRaw.trim())
    ) {
      return sendTeacherError(
        res,
        validationError('studentId 必须是非空字符串', 'studentId'),
      );
    }
    const studentId = typeof studentIdRaw === 'string' ? studentIdRaw.trim() : undefined;
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    const from = parseIsoInstant(fromRaw);
    const to = parseIsoInstant(toRaw);
    if (
      (fromRaw !== undefined && (typeof fromRaw !== 'string' || !from))
      || (toRaw !== undefined && (typeof toRaw !== 'string' || !to))
      || (from && to && from >= to)
    ) {
      return sendTeacherError(
        res,
        validationError('from/to 必须是合法 ISO 时间且 from < to', 'query'),
      );
    }
    const result = await dependencies.ledger.listEntries({
      teacherId: teacher.value,
      studentId,
      from,
      to,
    });
    sendResult(res, result);
  });

  router.post('/lesson-ledger/adjustments/:confirmationId/confirm', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const confirmationId = typeof req.params.confirmationId === 'string' ? req.params.confirmationId.trim() : '';
    if (!confirmationId) return sendTeacherError(res, validationError('confirmationId 必填', 'confirmationId'));
    const result = await dependencies.ledger.confirmAdjustment({
      teacherId: teacher.value,
      confirmationId,
    });
    sendResult(res, result);
  });

  router.post('/lesson-status-corrections/:confirmationId/confirm', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const confirmationId = typeof req.params.confirmationId === 'string' ? req.params.confirmationId.trim() : '';
    if (!confirmationId) return sendTeacherError(res, validationError('confirmationId 必填', 'confirmationId'));
    const result = await dependencies.lessonStatusCorrections.confirmLessonStatusCorrection({ teacherId: teacher.value, confirmationId });
    sendResult(res, result);
  });

  return router;
}
