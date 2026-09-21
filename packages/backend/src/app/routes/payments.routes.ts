import { Router } from 'express';
import type { PaymentRouteDependencies } from '../composition/types.js';
import { getTeacherId, parseDate, parseNumber, sendResult, sendTeacherError } from './api-helpers.js';

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
    const result = await dependencies.ledger.listEntries({
      teacherId: teacher.value,
      studentId: typeof req.query.studentId === 'string' ? req.query.studentId : undefined,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
    });
    sendResult(res, result);
  });

  return router;
}
