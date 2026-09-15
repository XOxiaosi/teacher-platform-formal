import { Router, type Request, type Response } from 'express';
import { validationError, type CommonError } from '@teacher-platform/contracts';
import type {
  MessageReceipt,
  SourceRef,
  StepDTO,
  TaskDTO,
  TaskDetailDTO,
  TaskEventDTO,
  TeachingTaskService,
} from '../../features/teaching-tasks/index.js';

type PlainObject = Record<string, unknown>;

const taskKeys = new Set(['conversationId', 'clientRequestId', 'message', 'materialRefs']);
const messageKeys = new Set(['clientRequestId', 'message', 'expectedVersion', 'materialRefs']);
const resumeKeys = new Set(['executionId', 'expectedVersion']);
const conversationKeys = new Set<string>();

export function createTeachingTaskRouter(service: TeachingTaskService): Router {
  const router = Router();

  router.post('/teaching-conversations', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const body = exactObject(req.body, conversationKeys);
    if (!body.ok) return sendError(res, body.error);
    const result = await service.createConversation({ teacherId });
    if (!result.ok) return sendError(res, result.error);
    res.status(201).json({ ok: true, data: result.value });
  });

  router.post('/teaching-tasks', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const parsed = parseMessageBody(req.body, taskKeys, true, false);
    if (!parsed.ok) return sendError(res, parsed.error);
    const result = await service.receiveMessage({ teacherId, ...parsed.value, conversationId: parsed.value.conversationId as string });
    if (!result.ok) return sendError(res, result.error);
    res.status(result.value.replayed ? 200 : 202).json({
      ok: true,
      data: { task: safeTask(result.value.task), receipt: safeReceipt(result.value.receipt), replayed: result.value.replayed },
    });
  });

  router.post('/teaching-tasks/:taskId/messages', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const taskId = parsePathId(req.params.taskId, 'taskId');
    if (!taskId.ok) return sendError(res, taskId.error);
    const parsed = parseMessageBody(req.body, messageKeys, false, true);
    if (!parsed.ok) return sendError(res, parsed.error);
    const detail = await service.getTask({ teacherId, taskId: taskId.value });
    if (!detail.ok) return sendError(res, detail.error);
    const result = await service.receiveMessage({
      teacherId,
      taskId: taskId.value,
      conversationId: detail.value.task.conversationId,
      ...parsed.value,
    });
    if (!result.ok) return sendError(res, result.error);
    res.status(result.value.replayed ? 200 : 202).json({
      ok: true,
      data: { task: safeTask(result.value.task), receipt: safeReceipt(result.value.receipt), replayed: result.value.replayed },
    });
  });

  router.get('/teaching-tasks', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const parsed = parseListQuery(req.query);
    if (!parsed.ok) return sendError(res, parsed.error);
    const result = await service.listTasks({ teacherId, ...parsed.value });
    if (!result.ok) return sendError(res, result.error);
    res.json({ ok: true, data: { items: result.value.items.map(safeTask), nextCursor: result.value.nextCursor } });
  });

  router.get('/teaching-tasks/:taskId', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const taskId = parsePathId(req.params.taskId, 'taskId');
    if (!taskId.ok) return sendError(res, taskId.error);
    const result = await service.getTask({ teacherId, taskId: taskId.value });
    if (!result.ok) return sendError(res, result.error);
    res.json({ ok: true, data: safeDetail(result.value) });
  });

  router.get('/teaching-tasks/:taskId/events', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const taskId = parsePathId(req.params.taskId, 'taskId');
    if (!taskId.ok) return sendError(res, taskId.error);
    const query = parseEventsQuery(req.query);
    if (!query.ok) return sendError(res, query.error);
    const result = await service.listTaskEvents({ teacherId, taskId: taskId.value, ...query.value });
    if (!result.ok) return sendError(res, result.error);
    res.json({ ok: true, data: { items: result.value.items.map(safeEvent), nextSeq: result.value.nextSeq } });
  });

  router.post('/teaching-tasks/:taskId/resume', async (req, res) => {
    const teacherId = requireTeacher(req, res);
    if (!teacherId) return;
    const taskId = parsePathId(req.params.taskId, 'taskId');
    if (!taskId.ok) return sendError(res, taskId.error);
    const body = exactObject(req.body, resumeKeys);
    if (!body.ok) return sendError(res, body.error);
    const executionId = requiredString(body.value.executionId, 'executionId');
    const expectedVersion = nonNegativeInt(body.value.expectedVersion, 'expectedVersion');
    if (!executionId.ok) return sendError(res, executionId.error);
    if (!expectedVersion.ok) return sendError(res, expectedVersion.error);
    const result = await service.resume({ teacherId, taskId: taskId.value, executionId: executionId.value, expectedVersion: expectedVersion.value });
    if (!result.ok) return sendError(res, result.error);
    res.json({ ok: true, data: { task: safeTask(result.value.task), replayed: result.value.replayed } });
  });

  return router;
}

function requireTeacher(req: Request, res: Response): string | undefined {
  const teacherId = (req as Request & { teacherId?: unknown }).teacherId;
  if (typeof teacherId !== 'string' || teacherId.trim() === '') {
    res.status(401).json({ ok: false, error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' } });
    return undefined;
  }
  return teacherId;
}

function parseMessageBody(body: unknown, keys: Set<string>, allowConversation: boolean, requireExpectedVersion: boolean) {
  const exact = exactObject(body, keys);
  if (!exact.ok) return exact;
  if (allowConversation) {
    const conversationId = requiredString(exact.value.conversationId, 'conversationId');
    if (!conversationId.ok) return conversationId;
  }
  const clientRequestId = requiredString(exact.value.clientRequestId, 'clientRequestId');
  const message = requiredString(exact.value.message, 'message');
  const expectedVersion = exact.value.expectedVersion === undefined
    ? (requireExpectedVersion
      ? { ok: false as const, error: validationError('expectedVersion 必须是非负整数', 'expectedVersion') }
      : { ok: true as const, value: undefined })
    : nonNegativeInt(exact.value.expectedVersion, 'expectedVersion');
  const materialRefs = parseMaterialRefs(exact.value.materialRefs);
  if (!clientRequestId.ok) return clientRequestId;
  if (!message.ok) return message;
  if (!expectedVersion.ok) return expectedVersion;
  if (!materialRefs.ok) return materialRefs;
  return {
    ok: true as const,
    value: {
      ...(allowConversation ? { conversationId: exact.value.conversationId as string } : {}),
      clientRequestId: clientRequestId.value,
      message: message.value,
      ...(expectedVersion.value === undefined ? {} : { expectedVersion: expectedVersion.value }),
      ...(materialRefs.value === undefined ? {} : { materialRefs: materialRefs.value }),
    },
  };
}

function parseMaterialRefs(value: unknown): { ok: true; value: SourceRef[] | undefined } | { ok: false; error: CommonError } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, error: validationError('materialRefs 必须是数组', 'materialRefs') };
  const refs: SourceRef[] = [];
  for (const item of value) {
    const exact = exactObject(item, new Set(['type', 'id', 'version']));
    if (!exact.ok) return { ok: false, error: validationError('materialRefs 项不合法', 'materialRefs') };
    const type = requiredString(exact.value.type, 'materialRefs');
    const id = requiredString(exact.value.id, 'materialRefs');
    const version = requiredString(exact.value.version, 'materialRefs');
    if (!type.ok || !id.ok || !version.ok) return { ok: false, error: validationError('materialRefs 项不合法', 'materialRefs') };
    refs.push({ type: type.value, id: id.value, version: version.value });
  }
  if (refs.length > 0) return { ok: false, error: validationError('本批不接受材料来源引用', 'materialRefs') };
  return { ok: true, value: refs };
}

function parseListQuery(query: Request['query']) {
  const keys = new Set(['conversationId', 'cursor', 'limit']);
  const exact = exactObject(query, keys);
  if (!exact.ok) return exact;
  const result: { conversationId?: string; cursor?: string; limit?: number } = {};
  for (const key of ['conversationId', 'cursor'] as const) {
    if (exact.value[key] !== undefined) {
      const parsed = requiredString(exact.value[key], key);
      if (!parsed.ok) return parsed;
      result[key] = parsed.value;
    }
  }
  if (exact.value.limit !== undefined) {
    const limit = queryPositiveInt(exact.value.limit, 'limit');
    if (!limit.ok) return limit;
    result.limit = limit.value;
  }
  return { ok: true as const, value: result };
}

function parseEventsQuery(query: Request['query']) {
  const exact = exactObject(query, new Set(['afterSeq', 'limit']));
  if (!exact.ok) return exact;
  const result: { afterSeq?: number; limit?: number } = {};
  if (exact.value.afterSeq !== undefined) {
    const afterSeq = queryNonNegativeInt(exact.value.afterSeq, 'afterSeq');
    if (!afterSeq.ok) return afterSeq;
    result.afterSeq = afterSeq.value;
  }
  if (exact.value.limit !== undefined) {
    const limit = queryPositiveInt(exact.value.limit, 'limit');
    if (!limit.ok) return limit;
    result.limit = limit.value;
  }
  return { ok: true as const, value: result };
}

function parsePathId(value: string | undefined, field: string) {
  return requiredString(value, field);
}

function exactObject(value: unknown, allowed: Set<string>): { ok: true; value: PlainObject } | { ok: false; error: CommonError } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }
  const object = value as PlainObject;
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    return { ok: false, error: validationError('请求包含不支持的字段', 'body') };
  }
  return { ok: true, value: object };
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false as const, error: validationError(`${field} 必须是非空字符串`, field) };
  return { ok: true as const, value };
}

function nonNegativeInt(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { ok: false as const, error: validationError(`${field} 必须是非负安全整数`, field) };
  return { ok: true as const, value };
}

function queryNonNegativeInt(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return { ok: false as const, error: validationError(`${field} 必须是非负十进制整数`, field) };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { ok: false as const, error: validationError(`${field} 超出范围`, field) };
  return { ok: true as const, value: parsed };
}

function queryPositiveInt(value: unknown, field: string) {
  const parsed = queryNonNegativeInt(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value < 1) return { ok: false as const, error: validationError(`${field} 必须是正整数`, field) };
  return parsed;
}

function safeTask(task: TaskDTO): TaskDTO {
  return {
    id: task.id, conversationId: task.conversationId, currentExecutionId: task.currentExecutionId,
    title: task.title, status: task.status, version: task.version, createdAt: task.createdAt,
    updatedAt: task.updatedAt, lastError: task.lastError, canResume: task.canResume,
    runtimeAvailability: task.runtimeAvailability,
  };
}

function safeReceipt(receipt: MessageReceipt): MessageReceipt {
  return { executionId: receipt.executionId, userTurnId: receipt.userTurnId, clientRequestId: receipt.clientRequestId, receivedAt: receipt.receivedAt };
}

function safeDetail(detail: TaskDetailDTO): TaskDetailDTO {
  return {
    task: safeTask(detail.task),
    executions: detail.executions.map((execution) => ({ id: execution.id, status: execution.status, clientRequestId: execution.clientRequestId, createdAt: execution.createdAt })),
    steps: detail.steps.map(safeStep),
  };
}

function safeStep(step: StepDTO): StepDTO {
  return { id: step.id, executionId: step.executionId, kind: step.kind, status: step.status, result: step.result, sourceRefs: step.sourceRefs.map((ref) => ({ type: ref.type, id: ref.id, version: ref.version })), confirmation: null, error: step.error };
}

function safeEvent(event: TaskEventDTO): TaskEventDTO {
  return {
    seq: event.seq, eventKey: event.eventKey, eventKind: event.eventKind,
    executionId: event.executionId, role: event.role, content: event.content, createdAt: event.createdAt,
  };
}

function sendError(res: Response, error: CommonError): void {
  const status = error.code === 'VALIDATION_ERROR' ? 400
    : error.code === 'PERMISSION_DENIED' ? 403
      : error.code === 'NOT_FOUND' ? 404
        : error.code === 'ALREADY_CONSUMED' || error.code === 'VERSION_CONFLICT' ? 409 : 500;
  res.status(status).json({ ok: false, error });
}
