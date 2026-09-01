import { Router } from 'express';
import type { StudentRouteDependencies } from '../composition/types.js';
import { getTeacherId, parseNumber, sendResult, sendTeacherError } from './api-helpers.js';

export function createStudentRouter(dependencies: StudentRouteDependencies): Router {
  const router = Router();

  router.get('/students', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.students.listStudents({
      teacherId: teacher.value,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      page: parseNumber(req.query.page),
      pageSize: parseNumber(req.query.pageSize),
    });
    sendResult(res, result);
  });

  router.post('/students', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.students.createStudent({
      teacherId: teacher.value,
      name: req.body.name,
      grade: req.body.grade,
      source: req.body.source,
      stageGoal: req.body.stageGoal,
    });
    sendResult(res, result, 201);
  });

  router.get('/students/:studentId/profile', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.studentProfile.execute({
      teacherId: teacher.value,
      studentId: req.params.studentId,
    });
    sendResult(res, result);
  });

  router.get('/students/:studentId/balance', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.balanceCalc.calculateBalance({
      teacherId: teacher.value,
      studentId: req.params.studentId,
    });
    sendResult(res, result);
  });

  return router;
}
