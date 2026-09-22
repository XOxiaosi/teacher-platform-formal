import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';
import { createWorkspaceWebService } from './workspace-web.service.js';

/** Mounted inside the existing session guard and request-scoped database router. */
export function createWorkspaceWebRouter(options: { getClient: () => Promise<PrismaClient> }) {
  const router = Router();
  const service = createWorkspaceWebService(options);
  router.get('/workspace-web/state', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    sendResult(res, await service.state(teacher.value));
  });
  router.post('/workspace-web/:operation', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    sendResult(res, await service.mutate(teacher.value, req.params.operation, req.body));
  });
  return router;
}
