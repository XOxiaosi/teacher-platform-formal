import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type TaskRuntime } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, versionConflict, type CommonError, type Result } from '@teacher-platform/contracts';
import { encryptFieldValue, encryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { taskDto } from './teaching-task-reader.js';
import type { RuntimeAvailability, TaskError, TeachingTaskLease, TeachingTaskService } from './types.js';

type Options = { getClient: () => Promise<PrismaClient>; cipher?: FieldCipher; availability: RuntimeAvailability; leaseMs: number };
type Locked = { task: TaskRuntime; at: Date; uncertain: boolean };
class TaskFailure extends Error {
  constructor(readonly detail: CommonError) { super(detail.message); }
}
const conflict = (field: string): never => { throw new TaskFailure({ ...versionConflict(), field }); };

async function lockOwned(tx: Prisma.TransactionClient, input: { taskId: string; teacherId: string }): Promise<Locked> {
  const target = await tx.taskRuntime.findFirst({ where: { id: input.taskId, teacherId: input.teacherId } });
  if (!target) throw new TaskFailure(notFound('教学任务不存在'));
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Conversation" WHERE id = ${target.conversationId} AND "teacherId" = ${input.teacherId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "TaskRuntime" WHERE id = ${input.taskId} AND "teacherId" = ${input.teacherId} FOR UPDATE`);
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const at = rows[0]?.now;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TaskFailure(internalError('数据库可信时间不可用'));
  const conversation = await tx.conversation.findFirst({ where: { id: target.conversationId, teacherId: input.teacherId, status: 'active', runtimeOwner: 'dsh-v1' } });
  if (!conversation) conflict('conversationId');
  const task = await tx.taskRuntime.findFirst({ where: { id: input.taskId, teacherId: input.teacherId, conversationId: target.conversationId } });
  if (!task) throw new TaskFailure(notFound('教学任务不存在'));
  const uncertain = await tx.stepReceipt.count({ where: { taskId: task.id, teacherId: input.teacherId, status: 'uncertain' } }) > 0;
  return { task, at, uncertain };
}

function assertLease({ task, at }: Locked, input: TeachingTaskLease): void {
  if (task.status !== 'running' || task.leaseToken !== input.leaseToken || task.leaseEpoch !== input.leaseEpoch
    || !task.leaseExpiresAtTs || task.leaseExpiresAtTs <= at) conflict('lease');
}

async function assertExecution(tx: Prisma.TransactionClient, task: TaskRuntime, executionId: string): Promise<void> {
  if (task.currentExecutionId !== executionId) conflict('executionId');
  const execution = await tx.agentExecution.findFirst({ where: { id: executionId, taskId: task.id, teacherId: task.teacherId, conversationId: task.conversationId } });
  if (!execution) conflict('executionId');
}

function cleanError(error: TaskError): TaskError {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

export function createTeachingTaskLeaseMethods({ getClient, cipher, availability, leaseMs }: Options):
  Pick<TeachingTaskService, 'claim' | 'heartbeat' | 'resume' | 'finish'> {
  const encrypted = (value: unknown) => encryptJsonFieldValue(cipher, value) as Prisma.InputJsonValue;
  async function run<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<Result<T, CommonError>> {
    if (!cipher) return err(internalError('SAFETY_BLOCK: 缺少 ENCRYPTION_KEY，拒绝教学任务写入'));
    try { return ok(await (await getClient()).$transaction(action)); }
    catch (error) { return err(error instanceof TaskFailure ? error.detail : internalError('教学任务事务失败')); }
  }
  async function event(tx: Prisma.TransactionClient, task: TaskRuntime, at: Date,
    kind: 'task_state' | 'task_error' | 'assistant_message', content: string): Promise<void> {
    const conversation = await tx.conversation.update({ where: { id: task.conversationId }, data: { nextEventSeq: { increment: 1 }, updatedAtTs: at } });
    await tx.conversationTurn.create({ data: {
      teacherId: task.teacherId, conversationId: task.conversationId, taskId: task.id,
      executionId: task.currentExecutionId, seq: conversation.nextEventSeq,
      eventKey: `task:${task.id}:${kind}:${task.version}`, eventKind: kind,
      role: kind === 'assistant_message' ? 'assistant' : kind === 'task_error' ? 'error' : 'tool',
      content: encryptFieldValue(cipher, content), createdAtTs: at,
    } });
  }
  return {
    claim(input) {
      return run(async (tx) => {
        const locked = await lockOwned(tx, input);
        const { task, at, uncertain } = locked;
        if (availability === 'unavailable') return { task: taskDto(task, cipher, availability, uncertain), unavailable: true as const };
        if (uncertain) conflict('stepStatus');
        if (!(task.status === 'queued' || (task.status === 'running' && task.leaseExpiresAtTs && task.leaseExpiresAtTs <= at))) conflict('taskStatus');
        await assertExecution(tx, task, task.currentExecutionId ?? '');
        const token = randomUUID();
        const updated = await tx.taskRuntime.update({ where: { id: task.id }, data: {
          status: 'running', leaseToken: token, leaseEpoch: { increment: 1 },
          leaseExpiresAtTs: new Date(at.getTime() + leaseMs), attemptCount: { increment: 1 },
          version: { increment: 1 }, updatedAtTs: at,
        } });
        await tx.agentExecution.update({ where: { id: updated.currentExecutionId! }, data: { status: 'running', stage: 'model', finishedAtTs: null, updatedAtTs: at } });
        await event(tx, updated, at, 'task_state', '任务开始执行');
        return { task: taskDto(updated, cipher, availability), lease: {
          taskId: task.id, teacherId: task.teacherId, leaseToken: token, leaseEpoch: updated.leaseEpoch,
        } };
      });
    },
    heartbeat(input) {
      return run(async (tx) => {
        const locked = await lockOwned(tx, input);
        assertLease(locked, input);
        const updated = await tx.taskRuntime.update({ where: { id: locked.task.id }, data: {
          leaseExpiresAtTs: new Date(locked.at.getTime() + leaseMs), updatedAtTs: locked.at,
        } });
        return taskDto(updated, cipher, availability, locked.uncertain);
      });
    },
    resume(input) {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return Promise.resolve(err(validationError('expectedVersion 必须是非负整数', 'expectedVersion')));
      return run(async (tx) => {
        const { task, at, uncertain } = await lockOwned(tx, input);
        await assertExecution(tx, task, input.executionId);
        if (task.resumeFromVersion === input.expectedVersion && task.resumeExecutionId === input.executionId) {
          return { task: taskDto(task, cipher, availability, uncertain), replayed: true };
        }
        if (task.version !== input.expectedVersion) conflict('expectedVersion');
        if (uncertain) conflict('stepStatus');
        if (!['partial', 'failed', 'unavailable'].includes(task.status)) conflict('taskStatus');
        if (task.leaseToken && task.leaseExpiresAtTs && task.leaseExpiresAtTs > at) conflict('lease');
        const nextStatus = availability === 'unavailable' ? 'unavailable' : 'queued';
        const updated = await tx.taskRuntime.update({ where: { id: task.id }, data: {
          status: nextStatus, leaseToken: null, leaseExpiresAtTs: null, version: { increment: 1 },
          resumeFromVersion: input.expectedVersion, resumeExecutionId: input.executionId,
          lastError: nextStatus === 'unavailable' ? encrypted({ code: 'RUNTIME_UNAVAILABLE', message: '教学任务运行能力当前不可用', retryable: true }) : Prisma.DbNull, updatedAtTs: at,
        } });
        await tx.agentExecution.update({ where: { id: input.executionId }, data: { status: nextStatus, stage: 'conversation', finishedAtTs: null, updatedAtTs: at } });
        await event(tx, updated, at, 'task_state', nextStatus === 'unavailable' ? '运行能力暂不可用，任务已保存' : '任务已排队继续');
        return { task: taskDto(updated, cipher, availability), replayed: false };
      });
    },
    finish(input) {
      if (!['succeeded', 'partial', 'failed', 'waiting_input'].includes(input.status)) return Promise.resolve(err(validationError('任务结束状态无效', 'status')));
      if (input.reply !== undefined && (typeof input.reply !== 'string' || !input.reply.trim())) return Promise.resolve(err(validationError('回复不能为空', 'reply')));
      if (input.error && (typeof input.error.code !== 'string' || typeof input.error.message !== 'string' || typeof input.error.retryable !== 'boolean')) return Promise.resolve(err(validationError('错误回执无效', 'error')));
      return run(async (tx) => {
        const locked = await lockOwned(tx, input);
        assertLease(locked, input);
        const { task, at, uncertain } = locked;
        await assertExecution(tx, task, input.executionId);
        if (input.status === 'succeeded' && await tx.stepReceipt.count({ where: { teacherId: task.teacherId, taskId: task.id, executionId: input.executionId, status: { not: 'succeeded' } } }) > 0) conflict('stepStatus');
        const updated = await tx.taskRuntime.update({ where: { id: task.id }, data: {
          status: input.status, leaseToken: null, leaseExpiresAtTs: null,
          version: { increment: 1 }, lastError: input.error ? encrypted(cleanError(input.error)) : Prisma.DbNull, updatedAtTs: at,
        } });
        await tx.agentExecution.update({ where: { id: input.executionId }, data: {
          status: input.status, stage: 'persistence', reply: input.reply === undefined ? undefined : encryptFieldValue(cipher, input.reply),
          error: input.error ? encrypted(cleanError(input.error)) : Prisma.DbNull,
          finishedAtTs: input.status === 'waiting_input' ? null : at, updatedAtTs: at,
        } });
        if (input.reply !== undefined) await event(tx, updated, at, 'assistant_message', input.reply);
        await event(tx, updated, at, input.error ? 'task_error' : 'task_state', input.error ? '任务执行失败' : '任务状态已更新');
        return taskDto(updated, cipher, availability, uncertain);
      });
    },
  };
}
