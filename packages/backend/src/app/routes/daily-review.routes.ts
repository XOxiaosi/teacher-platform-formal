import { validationError } from '@teacher-platform/contracts';
import { Router } from 'express';
import type { DailyReviewRouteDependencies } from '../composition/types.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';

export function createDailyReviewRouter(dependencies: DailyReviewRouteDependencies): Router {
  const router = Router();

  router.post('/daily-review/assemble', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (!isPlainObject(req.body)) {
      return sendTeacherError(res, validationError('请求体必须是对象', 'body'));
    }
    if (req.body.date !== undefined && typeof req.body.date !== 'string') {
      return sendTeacherError(res, validationError('date 必须是 YYYY-MM-DD 格式', 'date'));
    }
    const result = await dependencies.dailyReview.assembleDailyReview({
      teacherId: teacher.value,
      date: req.body.date,
    });
    sendResult(res, result, 201);
  });

  return router;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
