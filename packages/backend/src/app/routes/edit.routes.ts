import { Router, type Request, type Response } from 'express';
import { internalError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { EditRouteDependencies } from '../composition/types.js';
import {
  getTeacherId,
  readExactEditBody,
  sendResult,
  sendTeacherError,
} from './api-helpers.js';

export function createEditRouter(dependencies: EditRouteDependencies): Router {
  const router = Router();

  router.patch('/students/:studentId/profile', async (req, res) => {
    await handleEdit(req, res, 'changes', async (teacherId, body) => (
      dependencies.updateStudentProfile.updateStudentProfile({
        teacherId,
        studentId: req.params.studentId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        source: 'manual-web',
        changes: body.changes,
      })
    ));
  });

  router.post('/schedules/:scheduleId/reschedule', async (req, res) => {
    await handleEdit(req, res, 'replacement', async (teacherId, body) => (
      dependencies.rescheduleLesson.rescheduleLesson({
        teacherId,
        scheduleId: req.params.scheduleId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        source: 'manual-web',
        replacement: body.replacement,
      })
    ));
  });

  router.patch('/lessons/:lessonId/record', async (req, res) => {
    await handleEdit(req, res, 'changes', async (teacherId, body) => (
      dependencies.updateLessonRecord.updateLessonRecord({
        teacherId,
        lessonId: req.params.lessonId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        source: 'manual-web',
        changes: body.changes,
      })
    ));
  });

  router.patch('/payments/:paymentId', async (req, res) => {
    await handleEdit(req, res, 'changes', async (teacherId, body) => (
      dependencies.updatePayment.updatePayment({
        teacherId,
        paymentId: req.params.paymentId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        source: 'manual-web',
        changes: body.changes,
      })
    ));
  });

  router.patch('/memos/:memoId', async (req, res) => {
    await handleEdit(req, res, 'changes', async (teacherId, body) => (
      dependencies.updateMemo.updateMemo({
        teacherId,
        memoId: req.params.memoId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        source: 'manual-web',
        changes: body.changes,
      })
    ));
  });

  router.patch('/feedback/:feedbackId/content', async (req, res) => {
    await handleEdit(req, res, 'changes', async (teacherId, body) => (
      dependencies.updateParentFeedbackContent.updateParentFeedbackContent({
        teacherId,
        feedbackId: req.params.feedbackId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        source: 'manual-web',
        changes: body.changes,
      })
    ));
  });

  return router;
}

async function handleEdit<K extends 'changes' | 'replacement'>(
  req: Request,
  res: Response,
  payloadKey: K,
  run: (
    teacherId: string,
    body: Record<'expectedUpdatedAt' | K, never>,
  ) => Promise<Result<unknown, CommonError>>,
): Promise<void> {
  const teacher = getTeacherId(req);
  if (!teacher.ok) {
    sendTeacherError(res, teacher.error);
    return;
  }
  const body = readExactEditBody(req.body, payloadKey);
  if (!body.ok) {
    sendTeacherError(res, body.error);
    return;
  }
  try {
    sendResult(res, await run(teacher.value, body.value));
  } catch {
    sendTeacherError(res, internalError('编辑操作失败'));
  }
}
