import { Router } from 'express';
import type { AiInputRouteDependencies } from '../composition/types.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';

export function createAiInputRouter(dependencies: AiInputRouteDependencies): Router {
  const router = Router();

  router.post('/ai/raw-input', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.saveRawInput.saveRawInput({
      teacherId: teacher.value,
      inputType: req.body.inputType ?? 'text',
      text: req.body.text,
    });
    sendResult(res, result, 201);
  });

  return router;
}
