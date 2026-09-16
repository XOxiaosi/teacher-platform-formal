import type { PrismaClient, Prisma, TaskRuntime, StepReceipt } from '@prisma/client';
import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import { decryptFieldValue, decryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { parseSourceRefs } from './teaching-task-sources.js';
import type { RuntimeAvailability, StepDTO, TaskDTO, TaskError, TeachingTaskService, TaskEventDTO } from './types.js';

type ReaderOptions = {
  getClient: () => Promise<PrismaClient>;
  cipher?: FieldCipher;
  availability: RuntimeAvailability;
};

function errorDto(value: unknown): TaskError | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return typeof row.code === 'string' && typeof row.message === 'string' && typeof row.retryable === 'boolean'
    ? { code: row.code, message: row.message, retryable: row.retryable } : null;
}

export function taskDto(row: TaskRuntime, cipher: FieldCipher | undefined, availability: RuntimeAvailability,
  hasUncertain = false, active = true): TaskDTO {
  const lastError = errorDto(decryptJsonFieldValue(cipher, row.lastError));
  return {
    id: row.id, conversationId: row.conversationId, currentExecutionId: row.currentExecutionId,
    title: row.title === null ? null : decryptFieldValue(cipher, row.title),
    status: row.status as TaskDTO['status'], version: row.version,
    createdAt: row.createdAtTs.toISOString(), updatedAt: row.updatedAtTs.toISOString(),
    lastError,
    // A hint only; mutation always rechecks ownership, lease and version in the DB.
    canResume: active && availability !== 'unavailable' && ['partial', 'failed', 'unavailable'].includes(row.status)
      && Boolean(row.currentExecutionId) && row.leaseToken === null && !hasUncertain
      && lastError?.retryable !== false,
    runtimeAvailability: availability,
  };
}

export function stepDto(row: StepReceipt, cipher: FieldCipher | undefined): StepDTO {
  const envelope = decryptJsonFieldValue(cipher, row.resultRef);
  const sourceRefs = parseSourceRefs(row.sourceRefs) ?? [];
  return {
    id: row.id, executionId: row.executionId, kind: 'query', status: row.status as StepDTO['status'],
    result: envelope && typeof envelope === 'object' && 'public' in envelope ? envelope.public : null,
    sourceRefs, confirmation: null, error: errorDto(decryptJsonFieldValue(cipher, row.error)),
  };
}

function encodeCursor(row: TaskRuntime): string {
  return Buffer.from(JSON.stringify([row.updatedAtTs.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(value: string): { at: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string'
      || typeof parsed[1] !== 'string' || !parsed[1]) return null;
    const at = new Date(parsed[0]);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== parsed[0]) return null;
    return { at, id: parsed[1] };
  } catch { return null; }
}

export function createTeachingTaskReader({ getClient, cipher, availability }: ReaderOptions):
  Pick<TeachingTaskService, 'getTask' | 'listTasks' | 'listTaskEvents'> {
  return {
    async getTask({ teacherId, taskId }) {
      const task = await (await getClient()).taskRuntime.findFirst({
        where: { id: taskId, teacherId },
        include: {
          conversation: { select: { status: true } },
          executions: { where: { teacherId }, orderBy: [{ createdAtTs: 'asc' }, { id: 'asc' }] },
          steps: { where: { teacherId }, orderBy: [{ createdAtTs: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!task) return err(notFound('教学任务不存在'));
      return ok({
        task: taskDto(task, cipher, availability, task.steps.some((step) => step.status === 'uncertain'), task.conversation.status === 'active'),
        executions: task.executions.map((execution) => ({
          id: execution.id, status: execution.status, clientRequestId: execution.clientRequestId,
          createdAt: execution.createdAtTs.toISOString(),
        })),
        steps: task.steps.filter((step) => step.kind === 'query' && step.status !== 'invalidated').map((step) => stepDto(step, cipher)),
      });
    },
    async listTasks(input) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return err(validationError('limit 必须是 1 到 50 的整数', 'limit'));
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (input.cursor !== undefined && !cursor) return err(validationError('cursor 无效', 'cursor'));
      const where: Prisma.TaskRuntimeWhereInput = {
        teacherId: input.teacherId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(cursor ? { OR: [
          { updatedAtTs: { lt: cursor.at } },
          { updatedAtTs: cursor.at, id: { lt: cursor.id } },
        ] } : {}),
      };
      const rows = await (await getClient()).taskRuntime.findMany({
        where, orderBy: [{ updatedAtTs: 'desc' }, { id: 'desc' }], take: limit + 1,
        include: {
          steps: { where: { teacherId: input.teacherId, status: 'uncertain' }, select: { id: true } },
          conversation: { select: { status: true } },
        },
      });
      const page = rows.slice(0, limit);
      return ok({
        items: page.map((row) => taskDto(row, cipher, availability, row.steps.length > 0, row.conversation.status === 'active')),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
      });
    },
    async listTaskEvents(input) {
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err(validationError('limit 必须是 1 到 100 的整数', 'limit'));
      if (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0)) return err(validationError('事件游标无效', 'afterSeq'));
      const db = await getClient();
      const task = await db.taskRuntime.findFirst({ where: { id: input.taskId, teacherId: input.teacherId } });
      if (!task) return err(notFound('教学任务不存在'));
      const rows = await db.conversationTurn.findMany({
        where: {
          conversationId: task.conversationId, teacherId: input.teacherId, taskId: task.id,
          seq: { gt: input.afterSeq ?? 0 }, redactedAtTs: null, invalidatedAtTs: null,
        },
        orderBy: { seq: 'asc' }, take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return ok({
        items: page.map((row): TaskEventDTO => ({
          seq: row.seq!, eventKey: row.eventKey!, eventKind: row.eventKind as TaskEventDTO['eventKind'],
          executionId: row.executionId, role: row.role as TaskEventDTO['role'],
          content: decryptFieldValue(cipher, row.content), createdAt: row.createdAtTs.toISOString(),
        })),
        nextSeq: rows.length > limit ? page[page.length - 1]!.seq : null,
      });
    },
  };
}
