import { Router } from 'express';
import type { RequirementService } from '../../features/requirements/index.js';
import {
  getTeacherId,
  parseNumber,
  readExactEditBody,
  sendResult,
  sendTeacherError,
} from './api-helpers.js';

/**
 * P2 用户发言需求追溯路由（D50 §5.1）：
 * - POST   /requirements   创建（owner 隔离：session 身份有则归属；可空=平台级）
 * - GET    /requirements   列表（owner 隔离：教师看自己的+平台级）
 * - PATCH  /requirements/:id  更新（乐观锁 expectedUpdatedAt 复用 edit 模式；verbatimQuote 不可改）
 */
export function createRequirementRouter(dependencies: { requirements: RequirementService }): Router {
  const router = Router();

  router.post('/requirements', async (req, res) => {
    const teacher = getTeacherId(req);
    const teacherId = teacher.ok ? teacher.value : undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await dependencies.requirements.createRequirement({
      teacherId,
      verbatimQuote: typeof body.verbatimQuote === 'string' ? body.verbatimQuote : '',
      sourceType: typeof body.sourceType === 'string' ? body.sourceType : undefined,
      sourceDbName: typeof body.sourceDbName === 'string' ? body.sourceDbName : undefined,
      sourceTurnId: typeof body.sourceTurnId === 'string' ? body.sourceTurnId : undefined,
      contextSummary: typeof body.contextSummary === 'string' ? body.contextSummary : undefined,
      occurredAtTs: typeof body.occurredAtTs === 'string' && body.occurredAtTs.trim() !== ''
        ? new Date(body.occurredAtTs)
        : undefined,
      parsedIntent: typeof body.parsedIntent === 'string' ? body.parsedIntent : undefined,
      category: typeof body.category === 'string' ? body.category : '',
      priority: typeof body.priority === 'string' ? body.priority : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      linkedDesignDoc: typeof body.linkedDesignDoc === 'string' ? body.linkedDesignDoc : undefined,
      linkedTaskId: typeof body.linkedTaskId === 'string' ? body.linkedTaskId : undefined,
      linkedCommitSha: typeof body.linkedCommitSha === 'string' ? body.linkedCommitSha : undefined,
    });
    sendResult(res, result, 201);
  });

  router.get('/requirements', async (req, res) => {
    const teacher = getTeacherId(req);
    const teacherId = teacher.ok ? teacher.value : undefined;
    const result = await dependencies.requirements.listRequirements({
      teacherId,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      page: parseNumber(req.query.page),
      pageSize: parseNumber(req.query.pageSize),
    });
    sendResult(res, result);
  });

  router.patch('/requirements/:requirementId', async (req, res) => {
    const teacher = getTeacherId(req);
    const teacherId = teacher.ok ? teacher.value : undefined;
    const parsed = readExactEditBody(req.body, 'changes');
    if (!parsed.ok) {
      sendTeacherError(res, parsed.error);
      return;
    }
    const result = await dependencies.requirements.updateRequirement({
      requirementId: req.params.requirementId,
      teacherId,
      expectedUpdatedAt: parsed.value.expectedUpdatedAt,
      changes: parsed.value.changes as {
        sourceType?: string;
        contextSummary?: string;
        parsedIntent?: string;
        category?: string;
        priority?: string;
        status?: string;
        linkedDesignDoc?: string;
        linkedTaskId?: string;
        linkedCommitSha?: string;
      },
    });
    sendResult(res, result);
  });

  return router;
}
