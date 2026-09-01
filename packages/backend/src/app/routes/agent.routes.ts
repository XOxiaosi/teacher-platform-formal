import { Router } from 'express';
import { validationError } from '@teacher-platform/contracts';
import type { AgentRouteDependencies } from '../composition/types.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';

export function createAgentRouter(dependencies: AgentRouteDependencies): Router {
  const router = Router();

  router.post('/agent/converse', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    if (!req.body.conversationId || typeof req.body.conversationId !== 'string') {
      return sendTeacherError(res, validationError('缺少 conversationId', 'conversationId'));
    }
    if (!req.body.message || typeof req.body.message !== 'string') {
      return sendTeacherError(res, validationError('缺少 message', 'message'));
    }
    if (!req.body.clientRequestId || typeof req.body.clientRequestId !== 'string') {
      return sendTeacherError(res, validationError('缺少 clientRequestId', 'clientRequestId'));
    }

    const result = await dependencies.agentConverse.execute({
      teacherId: teacher.value,
      conversationId: req.body.conversationId,
      message: req.body.message,
      clientRequestId: req.body.clientRequestId,
    });
    const successStatus = result.ok && result.value.status === 'running' ? 202 : 200;
    sendResult(res, result, successStatus);
  });

  router.post('/agent/executions/:executionId/replay', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (!req.body.clientRequestId || typeof req.body.clientRequestId !== 'string') {
      return sendTeacherError(res, validationError('缺少 clientRequestId', 'clientRequestId'));
    }
    const replay = await dependencies.agentExecutions.prepareReplay({
      teacherId: teacher.value,
      executionId: req.params.executionId,
      clientRequestId: req.body.clientRequestId,
    });
    if (!replay.ok) return sendResult(res, replay);
    const result = await dependencies.agentConverse.execute({ teacherId: teacher.value, ...replay.value });
    const successStatus = result.ok && result.value.status === 'running' ? 202 : 200;
    sendResult(res, result, successStatus);
  });

  router.get('/agent/executions/:executionId', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.agentExecutions.get({
      teacherId: teacher.value,
      executionId: req.params.executionId,
    });
    if (!result.ok) return sendResult(res, result);
    const execution = result.value;
    sendResult(res, {
      ok: true,
      value: {
        execution: {
          id: execution.id,
          conversationId: execution.conversationId,
          clientRequestId: execution.clientRequestId,
          status: execution.status,
          stage: execution.stage,
          reply: execution.reply,
          error: execution.error,
          completedToolCallIds: execution.completedToolCallIds,
          startedAt: execution.startedAt.toISOString(),
          finishedAt: execution.finishedAt?.toISOString() ?? null,
          updatedAtTs: execution.updatedAt.toISOString(),
        },
      },
    });
  });

  return router;
}
