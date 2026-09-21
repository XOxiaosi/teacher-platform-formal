import { Router } from 'express';
import type { PaymentRouteDependencies } from '../composition/types.js';
import { validationError } from '@teacher-platform/contracts';
import { getTeacherId, parseDate, parseNumber, sendResult, sendTeacherError } from './api-helpers.js';

const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

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

export function createPaymentRouter(dependencies: PaymentRouteDependencies): Router {
  const router = Router();

  router.get('/payments', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.payments.listPayments({
      teacherId: teacher.value,
      studentId: typeof req.query.studentId === 'string' ? req.query.studentId : undefined,
      paidAtFrom: parseDate(req.query.paidAtFrom),
      paidAtTo: parseDate(req.query.paidAtTo),
      page: parseNumber(req.query.page),
      pageSize: parseNumber(req.query.pageSize),
    });
    sendResult(res, result);
  });

  router.post('/payments', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.payments.createPayment({
      teacherId: teacher.value,
      studentId: req.body.studentId,
      amount: Number(req.body.amount),
      lessonCount: Number(req.body.lessonCount),
      paidAt: parseDate(req.body.paidAt) as Date,
      note: req.body.note,
    });
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

  return router;
}
