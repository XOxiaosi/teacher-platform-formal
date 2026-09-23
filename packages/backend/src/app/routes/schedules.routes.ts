import { Router } from 'express';
import { validationError } from '@teacher-platform/contracts';
import type { ScheduleRouteDependencies } from '../composition/types.js';
import { completionEntrypointUnavailable } from '../policies/completion-entrypoint-gate.js';
import {
  getTeacherId,
  parseDate,
  parseNumber,
  parseScheduleType,
  sendResult,
  sendTeacherError,
} from './api-helpers.js';

export function createScheduleRouter(dependencies: ScheduleRouteDependencies): Router {
  const router = Router();

  router.get('/schedules', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const scheduleType = parseScheduleType(req.query.type);
    if (!scheduleType.ok) return sendTeacherError(res, scheduleType.error);
    const result = await dependencies.schedules.listSchedules({
      teacherId: teacher.value,
      studentId: typeof req.query.studentId === 'string' ? req.query.studentId : undefined,
      type: scheduleType.value,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      dateFrom: parseDate(req.query.dateFrom),
      dateTo: parseDate(req.query.dateTo),
      page: parseNumber(req.query.page),
      pageSize: parseNumber(req.query.pageSize),
    });
    sendResult(res, result);
  });

  router.post('/schedules', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (req.body?.type === 'lesson' && req.body.title !== undefined) {
      return sendTeacherError(res, validationError('课程排期不接受课程名称', 'title'));
    }
    const result = await dependencies.plannedSchedules.create({
      teacherId: teacher.value,
      clientRequestId: req.body.clientRequestId,
      studentId: req.body.studentId,
      participantIds: req.body.participantIds,
      type: req.body.type,
      title: req.body.title,
      location: req.body.location,
      classFormat: req.body.classFormat,
      operationalNote: req.body.operationalNote,
      scheduledStart: req.body.scheduledStart,
      scheduledEnd: req.body.scheduledEnd,
      confidence: req.body.confidence,
      pendingFields: req.body.pendingFields,
      sourceInput: req.body.sourceInput,
    });
    sendResult(res, result, 201);
  });

  router.post('/schedules/:scheduleId/complete', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    // 旧入口没有实际出勤与扣课影响预览，不能默认全员已出勤后写入。
    // 保留 scheduleComplete 领域用例，待新的预览/确认闭环接入。
    return sendTeacherError(res, completionEntrypointUnavailable().error);
  });

  // D49: 手动删除课程 = 取消
  router.post('/schedules/:scheduleId/cancel', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.schedules.cancelSchedule({
      teacherId: teacher.value,
      scheduleId: req.params.scheduleId,
    });
    sendResult(res, result);
  });

  // D49: 误删恢复
  router.post('/schedules/:scheduleId/restore', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.schedules.restoreSchedule({
      teacherId: teacher.value,
      scheduleId: req.params.scheduleId,
    });
    sendResult(res, result);
  });

  return router;
}
