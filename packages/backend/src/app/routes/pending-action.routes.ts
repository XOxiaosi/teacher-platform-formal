import { Router } from 'express';
import { validationError } from '@teacher-platform/contracts';
import type { PendingActionService } from '../../features/pending-action/index.js';
import type { ConfirmPendingActionUseCase } from '../use-cases/confirm-pending-action/index.js';
import type { CancelPendingActionUseCase } from '../use-cases/cancel-pending-action/index.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';
import { toPendingActionDto } from './pending-action-response.js';

export interface PendingActionRouteDependencies {
  pendingActions: Pick<PendingActionService, 'getPendingAction' | 'listForConversationToolCalls'>;
  confirmPendingAction: ConfirmPendingActionUseCase;
  cancelPendingAction: CancelPendingActionUseCase;
}

export function createPendingActionRouter(
  dependencies: PendingActionRouteDependencies,
): Router {
  const router = Router();

  router.get('/pending-actions/:pendingActionId', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.pendingActions.getPendingAction({
      teacherId: teacher.value,
      pendingActionId: req.params.pendingActionId,
    });
    if (!result.ok) return sendResult(res, result);
    sendResult(res, { ok: true, value: { pendingAction: toPendingActionDto(result.value) } });
  });

  router.post('/pending-actions/:pendingActionId/confirm', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (typeof req.body.actionToken !== 'string' || req.body.actionToken.trim() === '') {
      return sendTeacherError(res, validationError('缺少 actionToken', 'actionToken'));
    }
    const result = await dependencies.confirmPendingAction.confirm({
      teacherId: teacher.value,
      pendingActionId: req.params.pendingActionId,
      actionToken: req.body.actionToken,
    });
    if (!result.ok) return sendResult(res, result);
    sendResult(res, {
      ok: true,
      value: {
        pendingAction: toPendingActionDto({
          pendingAction: result.value.pendingAction,
          actionToken: '',
        }),
        result: result.value.result,
      },
    });
  });

  router.post('/pending-actions/:pendingActionId/cancel', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.cancelPendingAction.cancel({
      teacherId: teacher.value,
      pendingActionId: req.params.pendingActionId,
    });
    if (!result.ok) return sendResult(res, result);
    sendResult(res, {
      ok: true,
      value: {
        pendingAction: toPendingActionDto({
          pendingAction: result.value.pendingAction,
          actionToken: '',
        }),
      },
    });
  });

  return router;
}
