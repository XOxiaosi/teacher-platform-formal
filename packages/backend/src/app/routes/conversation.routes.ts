import { Router } from 'express';
import { validationError } from '@teacher-platform/contracts';
import type { ConversationService, ConversationStatus } from '../../features/conversation/index.js';
import type {
  PendingActionService,
  PendingActionWithToken,
} from '../../features/pending-action/index.js';
import { getTeacherId, parseNumber, sendResult, sendTeacherError } from './api-helpers.js';
import {
  extractToolCallIds,
  toAgentTurnDtos,
  toConversationDetailDto,
  toConversationSummaryDto,
} from './conversation-response.js';

function parseStatus(value: unknown): ConversationStatus | undefined {
  return value === 'active' || value === 'archived' ? value : undefined;
}

export function createConversationRouter(
  conversations: ConversationService,
  pendingActions?: Pick<PendingActionService, 'listForConversationToolCalls'>,
): Router {
  const router = Router();

  router.post('/conversations', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const created = await conversations.createConversation({ teacherId: teacher.value });
    if (!created.ok) return sendResult(res, created);
    const projection = await conversations.getConversationProjection({
      conversationId: created.value.id,
      teacherId: teacher.value,
    });
    if (!projection.ok) return sendResult(res, projection);
    sendResult(res, { ok: true, value: { conversation: toConversationDetailDto(projection.value) } }, 201);
  });

  router.get('/conversations', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const status = parseStatus(req.query.status);
    if (req.query.status !== undefined && status === undefined) {
      return sendTeacherError(res, validationError('会话状态不合法', 'status'));
    }
    const limit = parseNumber(req.query.limit);
    if (req.query.limit !== undefined && limit === undefined) {
      return sendTeacherError(res, validationError('limit 必须是数字', 'limit'));
    }
    const result = await conversations.listConversations({
      teacherId: teacher.value,
      status,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit,
    });
    if (!result.ok) return sendResult(res, result);
    sendResult(res, {
      ok: true,
      value: {
        items: result.value.items.map(toConversationSummaryDto),
        nextCursor: result.value.nextCursor,
      },
    });
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const result = await conversations.getConversationProjection({
      conversationId: req.params.conversationId,
      teacherId: teacher.value,
    });
    if (!result.ok) return sendResult(res, result);
    sendResult(res, { ok: true, value: { conversation: toConversationDetailDto(result.value) } });
  });

  router.get('/conversations/:conversationId/turns', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const result = await conversations.listConversationTurnsPage({
      conversationId: req.params.conversationId,
      teacherId: teacher.value,
      before: typeof req.query.before === 'string' ? req.query.before : undefined,
      limit: parseNumber(req.query.limit),
    });
    if (!result.ok) return sendResult(res, result);
    let confirmations: PendingActionWithToken[] = [];
    if (pendingActions) {
      const listed = await pendingActions.listForConversationToolCalls({
        teacherId: teacher.value,
        conversationId: req.params.conversationId,
        toolCallIds: extractToolCallIds(result.value.items),
      });
      if (!listed.ok) return sendResult(res, listed);
      confirmations = listed.value;
    }
    sendResult(res, {
      ok: true,
      value: {
        items: toAgentTurnDtos(result.value.items, confirmations),
        previousCursor: result.value.previousCursor,
      },
    });
  });

  router.post('/conversations/:conversationId/archive', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const archived = await conversations.archiveConversation({
      conversationId: req.params.conversationId,
      teacherId: teacher.value,
    });
    if (!archived.ok) return sendResult(res, archived);
    const projection = await conversations.getConversationProjection({
      conversationId: archived.value.id,
      teacherId: teacher.value,
    });
    if (!projection.ok) return sendResult(res, projection);
    sendResult(res, { ok: true, value: { conversation: toConversationDetailDto(projection.value) } });
  });

  return router;
}
