import { Router } from 'express';
import { validationError } from '@teacher-platform/contracts';
import type { AgendaRouteDependencies } from '../composition/types.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';

export function createAgendaRouter(dependencies: AgendaRouteDependencies): Router {
  const router = Router();

  router.get('/agenda/today', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.agenda.getToday({
      teacherId: teacher.value,
      timeZone: 'Asia/Shanghai',
    });
    sendResult(res, result);
  });

  router.get('/agenda/week', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const weekStart = req.query.weekStart;
    if (weekStart !== undefined && typeof weekStart !== 'string') {
      return sendTeacherError(
        res,
        validationError('weekStart 必须是单个日期', 'weekStart'),
      );
    }
    const result = await dependencies.agenda.getWeek({
      teacherId: teacher.value,
      timeZone: 'Asia/Shanghai',
      ...(weekStart === undefined ? {} : { weekStart }),
    });
    sendResult(res, result);
  });

  return router;
}
