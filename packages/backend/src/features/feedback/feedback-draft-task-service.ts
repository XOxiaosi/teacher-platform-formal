import { createHash } from 'node:crypto';
import { err, internalError, notFound, ok, validationError, versionConflict, type CommonError } from '@teacher-platform/contracts';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createFieldCipherFromEnv, decryptJsonFieldValue, encryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type { CreateFeedbackDraftTaskInput, FeedbackDraftContextExecutor, FeedbackDraftGeneration, FeedbackDraftGeneratorExecutor, FeedbackDraftTaskData, FeedbackDraftTaskService, FeedbackDraftTaskStatus } from './types.js';

type Client = PrismaClient | Prisma.TransactionClient;
type StoredRequest = Omit<CreateFeedbackDraftTaskInput, 'teacherId'> & {
  initialEvidence?: FeedbackDraftGeneration['evidence'];
  windowStart?: string;
  windowEnd?: string;
};

type TaskRow = {
  id: string; teacherId: string; studentId: string; clientRequestId: string; requestFingerprint: string;
  status: string; version: number; attemptCount: number; retryable: boolean; requestCiphertext: string;
  draftCiphertext: string | null; generationCiphertext: string | null; errorCiphertext: string | null;
  savedFeedbackId: string | null; createdAtTs: Date; updatedAtTs: Date;
};
const RUNNING_LEASE_MS = 5 * 60 * 1000;

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function retryable(error: CommonError): boolean {
  return error.code === 'INTERNAL_ERROR' || error.code === 'RATE_LIMITED' || error.code === 'BUDGET_EXCEEDED';
}

function status(value: string): FeedbackDraftTaskStatus {
  if (value === 'running' || value === 'succeeded' || value === 'failed' || value === 'evidence_changed' || value === 'uncertain' || value === 'saved') return value;
  return 'uncertain';
}

function validateIdList(values: string[] | undefined, field: 'lessonIds' | 'recordIds'): CommonError | null {
  if (values === undefined) return null;
  if (values.length === 0 || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    return validationError(`${field} 如提供必须包含非空 ID`, field);
  }
  const normalized = values.map((value) => value.trim());
  if (new Set(normalized).size !== normalized.length) return validationError(`${field} 不允许重复`, field);
  return null;
}

/** Durable orchestration around the existing, backwards-compatible generator. */
export function createFeedbackDraftTaskService(options: {
  prisma: PrismaClient;
  getClient?: () => Promise<PrismaClient>;
  cipher?: FieldCipher;
  context: FeedbackDraftContextExecutor;
  generator: FeedbackDraftGeneratorExecutor;
}): FeedbackDraftTaskService {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  function decode<T>(value: string | null): T | null {
    if (!value) return null;
    return decryptJsonFieldValue(cipher, value) as T;
  }

  function dto(row: TaskRow): FeedbackDraftTaskData {
    const request = decode<StoredRequest>(row.requestCiphertext) ?? {} as StoredRequest;
    const draft = decode<{ title: string; content: string }>(row.draftCiphertext) ?? { title: request.title ?? '', content: request.content ?? '' };
    const generation = decode<FeedbackDraftGeneration>(row.generationCiphertext);
    const failure = decode<{ message: string; code?: string }>(row.errorCiphertext);
    return { id: row.id, studentId: row.studentId, status: status(row.status), version: row.version,
      attemptCount: row.attemptCount, retryable: row.retryable, request, draft, generation, error: failure,
      savedFeedbackId: row.savedFeedbackId, createdAt: row.createdAtTs, updatedAt: row.updatedAtTs };
  }

  async function owned(client: Client, teacherId: string, taskId: string): Promise<TaskRow | null> {
    return await client.feedbackDraftTask.findFirst({ where: { id: taskId, teacherId } }) as TaskRow | null;
  }

  async function databaseNow(client: Client): Promise<Date | null> {
    const result = await createDatabaseTrustedClock(client).now();
    return result.ok ? result.value : null;
  }

  async function taskUpdatedAt(client: Client): Promise<Date | null> {
    return databaseNow(client);
  }

  async function finalizeAttemptAndTask(
    client: Client,
    task: TaskRow,
    runVersion: number,
    attemptId: string,
    attemptData: Prisma.FeedbackDraftAttemptUpdateManyMutationInput,
    taskData: Prisma.FeedbackDraftTaskUpdateManyMutationInput,
  ): Promise<boolean> {
    const write = async (tx: Client) => {
      const attemptChanged = await tx.feedbackDraftAttempt.updateMany({
        where: { id: attemptId, status: 'running', modelCallEndedAtTs: null },
        data: attemptData,
      });
      if (attemptChanged.count !== 1) throw new Error('ATTEMPT_CAS_CONFLICT');
      const taskChanged = await tx.feedbackDraftTask.updateMany({
        where: { id: task.id, teacherId: task.teacherId, status: 'running', version: runVersion },
        data: taskData,
      });
      if (taskChanged.count !== 1) throw new Error('TASK_CAS_CONFLICT');
    };
    try {
      if ('$transaction' in client && typeof client.$transaction === 'function') await client.$transaction(write);
      else await write(client);
      return true;
    } catch {
      return false;
    }
  }

  async function reconcileStaleRunning(client: Client, task: TaskRow): Promise<TaskRow> {
    if (task.status !== 'running') return task;
    const attempt = await client.feedbackDraftAttempt.findFirst({ where: { taskId: task.id }, orderBy: { createdAtTs: 'desc' },
      select: { id: true, createdAtTs: true, modelCallStartedAtTs: true, modelCallEndedAtTs: true } });
    const leaseAt = attempt?.modelCallStartedAtTs ?? attempt?.createdAtTs;
    const current = await databaseNow(client);
    const inconsistentEndedAttempt = Boolean(attempt?.modelCallEndedAtTs);
    if (!attempt || !leaseAt || !current || (!inconsistentEndedAttempt && current.getTime() - leaseAt.getTime() < RUNNING_LEASE_MS)) return task;
    const write = async (tx: Client) => {
      const now = await taskUpdatedAt(tx);
      if (!now) return;
      const changed = await tx.feedbackDraftTask.updateMany({ where: { id: task.id, teacherId: task.teacherId, status: 'running', version: task.version },
        data: { status: 'uncertain', retryable: true, errorCiphertext: encryptJsonFieldValue(cipher, { message: '上次生成未收到完成回执，可重试恢复', code: 'UNCERTAIN' }), version: { increment: 1 }, updatedAtTs: now } });
      if (changed.count) await tx.feedbackDraftAttempt.updateMany({ where: { id: attempt.id, status: 'running', modelCallEndedAtTs: null }, data: { status: 'uncertain', updatedAtTs: now } });
    };
    if ('$transaction' in client && typeof client.$transaction === 'function') await client.$transaction(write);
    else await write(client);
    return (await owned(client, task.teacherId, task.id)) ?? task;
  }

  async function run(taskId: string, teacherId: string, attemptRequestId: string): Promise<FeedbackDraftTaskData> {
    const client = await getClient();
    const task = await owned(client, teacherId, taskId);
    if (!task) throw new Error('task disappeared');
    const request = decode<StoredRequest>(task.requestCiphertext);
    if (!request) throw new Error('SAFETY_BLOCK: 反馈草稿请求无法解密');
    const attempt = await client.feedbackDraftAttempt.findUnique({ where: { taskId_clientRequestId: { taskId, clientRequestId: attemptRequestId } } });
    if (!attempt) throw new Error('attempt disappeared');
    // The marker is intentionally committed before provider work. A duplicate
    // request therefore cannot issue a second model call after a process crash.
    const startedAt = await databaseNow(client);
    if (!startedAt) return await finishFailure(client, task, task.version, attempt.id, internalError('数据库可信时间不可用'));
    const claimed = await client.feedbackDraftAttempt.updateMany({ where: { id: attempt.id, modelCallStartedAtTs: null }, data: { modelCallStartedAtTs: startedAt, status: 'running', updatedAtTs: startedAt } });
    if (claimed.count !== 1) return dto((await owned(client, teacherId, taskId))!);
    const runVersion = task.version;
    try {
      const initial = await options.context.execute({ teacherId, studentId: task.studentId, lessonIds: request.lessonIds, recordIds: request.recordIds });
      if (!initial.ok) return await finishFailure(client, task, runVersion, attempt.id, initial.error);
      const frozen: StoredRequest = { ...request, initialEvidence: initial.value.evidence, windowStart: initial.value.windowStart, windowEnd: initial.value.windowEnd };
      const frozenAt = await taskUpdatedAt(client);
      if (!frozenAt) return await finishFailure(client, task, runVersion, attempt.id, internalError('数据库可信时间不可用'));
      const frozenSaved = await client.feedbackDraftTask.updateMany({ where: { id: task.id, teacherId, status: 'running', version: runVersion }, data: { requestCiphertext: encryptJsonFieldValue(cipher, frozen), updatedAtTs: frozenAt } });
      if (!frozenSaved.count) return dto((await owned(client, teacherId, task.id))!);
      const evidenceSelection = request.lessonIds !== undefined
        ? { lessonIds: request.lessonIds }
        : { recordIds: request.recordIds ?? initial.value.evidence.map(item => item.id) };
      const firstAttempt = task.attemptCount > 1
        ? await client.feedbackDraftAttempt.findFirst({ where: { taskId: task.id }, orderBy: { createdAtTs: 'asc' }, select: { id: true } })
        : attempt;
      const generated = await options.generator.execute({ teacherId, studentId: task.studentId, ...evidenceSelection,
        tone: request.tone, classSize: request.classSize, parentType: request.parentType, focus: request.focus,
        runtime: { taskId: task.id, executionId: firstAttempt?.id ?? attempt.id, contextEpoch: 0,
          ...(task.attemptCount > 1 ? { resume: true } : {}) } });
      if (!generated.ok) return await finishFailure(client, task, runVersion, attempt.id, generated.error);
      const changed = initial.value.evidence.length !== generated.value.evidence.length || initial.value.evidence.some((item) => {
        const next = generated.value.evidence.find(candidate => candidate.id === item.id);
        return !next || next.sourceVersion !== item.sourceVersion;
      });
      if (changed) {
        const problem = { message: '生成期间依据已变化，请核对后重试', code: 'EVIDENCE_CHANGED' };
        const endedAt = await databaseNow(client);
        if (!endedAt) return await finishFailure(client, task, runVersion, attempt.id, internalError('数据库可信时间不可用'));
        const finalized = await finalizeAttemptAndTask(client, task, runVersion, attempt.id,
          { status: 'evidence_changed', modelCallEndedAtTs: endedAt, updatedAtTs: endedAt, errorCiphertext: encryptJsonFieldValue(cipher, problem) },
          { status: 'evidence_changed', retryable: false, errorCiphertext: encryptJsonFieldValue(cipher, problem), version: { increment: 1 }, updatedAtTs: endedAt });
        if (!finalized) return dto((await owned(client, teacherId, task.id))!);
        return dto((await owned(client, teacherId, task.id))!);
      }
      const draft = { title: request.title?.trim() || generated.value.title, content: request.content?.trim() || generated.value.content };
      const generation: FeedbackDraftGeneration = { lessonIds: generated.value.lessonIds, evidence: generated.value.evidence,
        windowStart: generated.value.windowStart, windowEnd: generated.value.windowEnd, rationale: generated.value.rationale };
      const endedAt = await databaseNow(client);
      if (!endedAt) return await finishFailure(client, task, runVersion, attempt.id, internalError('数据库可信时间不可用'));
      const finalized = await finalizeAttemptAndTask(client, task, runVersion, attempt.id,
        { status: 'succeeded', modelCallEndedAtTs: endedAt, updatedAtTs: endedAt, resultCiphertext: encryptJsonFieldValue(cipher, { draft, generation }) },
        { status: 'succeeded', retryable: false, draftCiphertext: encryptJsonFieldValue(cipher, draft), generationCiphertext: encryptJsonFieldValue(cipher, generation), errorCiphertext: null, version: { increment: 1 }, updatedAtTs: endedAt });
      if (!finalized) return dto((await owned(client, teacherId, task.id))!);
      return dto((await owned(client, teacherId, task.id))!);
    } catch {
      return await finishFailure(client, task, runVersion, attempt.id, internalError('反馈生成暂未完成，请稍后重试'));
    }
  }

  async function finishFailure(client: Client, task: TaskRow, runVersion: number, attemptId: string, problem: CommonError): Promise<FeedbackDraftTaskData> {
    const failure = { message: problem.message, code: problem.code };
    const endedAt = await databaseNow(client);
    if (!endedAt) return dto((await owned(client, task.teacherId, task.id)) ?? task);
    const finalized = await finalizeAttemptAndTask(client, task, runVersion, attemptId,
      { status: 'failed', modelCallEndedAtTs: endedAt, updatedAtTs: endedAt, errorCiphertext: encryptJsonFieldValue(cipher, failure) },
      { status: 'failed', retryable: retryable(problem), errorCiphertext: encryptJsonFieldValue(cipher, failure), version: { increment: 1 }, updatedAtTs: endedAt });
    if (!finalized) return dto((await owned(client, task.teacherId, task.id))!);
    return dto((await owned(client, task.teacherId, task.id))!);
  }

  return {
    async create(input) {
      const client = await getClient();
      if (!input.clientRequestId?.trim() || input.clientRequestId.length > 128) return err(validationError('clientRequestId 必填且不超过 128 个字符', 'clientRequestId'));
      if (!input.studentId?.trim()) return err(validationError('studentId 必填', 'studentId'));
      const lessonIdsError = validateIdList(input.lessonIds, 'lessonIds');
      if (lessonIdsError) return err(lessonIdsError);
      const recordIdsError = validateIdList(input.recordIds, 'recordIds');
      if (recordIdsError) return err(recordIdsError);
      if (input.lessonIds !== undefined && input.recordIds !== undefined) return err(validationError('lessonIds 与 recordIds 不能同时提供'));
      const request: StoredRequest = { ...input,
        ...(input.lessonIds ? { lessonIds: input.lessonIds.map((value) => value.trim()) } : {}),
        ...(input.recordIds ? { recordIds: input.recordIds.map((value) => value.trim()) } : {}),
      };
      delete (request as { teacherId?: string }).teacherId;
      const hash = fingerprint(request);
      const student = await client.student.findFirst({ where: { id: input.studentId, teacherId: input.teacherId }, select: { id: true } });
      if (!student) return err(notFound('学生不存在'));
      try {
        const created = await client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`feedback-draft:${input.teacherId}:${input.clientRequestId}`}))`;
          const existing = await tx.feedbackDraftTask.findUnique({ where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } } }) as TaskRow | null;
          if (existing) return { task: existing, replayed: true };
          const now = await databaseNow(tx);
          if (!now) throw new Error('TRUSTED_TIME_UNAVAILABLE');
          const task = await tx.feedbackDraftTask.create({ data: { teacherId: input.teacherId, studentId: input.studentId, clientRequestId: input.clientRequestId,
          requestFingerprint: hash, requestCiphertext: encryptJsonFieldValue(cipher, request), draftCiphertext: encryptJsonFieldValue(cipher, { title: input.title ?? '', content: input.content ?? '' }), status: 'running', attemptCount: 1, createdAtTs: now, updatedAtTs: now } });
          await tx.feedbackDraftAttempt.create({ data: { taskId: task.id, teacherId: input.teacherId, clientRequestId: input.clientRequestId, requestFingerprint: hash, status: 'running', createdAtTs: now, updatedAtTs: now } });
          return { task: task as TaskRow, replayed: false };
        });
        if (created.replayed) {
          if (created.task.requestFingerprint !== hash) return err({ ...versionConflict(), message: '请求编号已用于另一份反馈草稿任务' });
          return ok({ task: dto(await reconcileStaleRunning(client, created.task)), replayed: true });
        }
        return ok({ task: await run(created.task.id, input.teacherId, input.clientRequestId), replayed: false });
      } catch {
        return err(internalError('创建反馈草稿任务失败'));
      }
    },
    async list(input) {
      const client = await getClient();
      const items = await client.feedbackDraftTask.findMany({ where: { teacherId: input.teacherId, savedFeedbackId: null, ...(input.studentId ? { studentId: input.studentId } : {}) }, orderBy: { updatedAtTs: 'desc' } });
      return ok({ items: (await Promise.all(items.map(row => reconcileStaleRunning(client, row as TaskRow)))).map(dto) });
    },
    async get(input) {
      const client = await getClient(); const task = await owned(client, input.teacherId, input.taskId);
      return task ? ok(dto(await reconcileStaleRunning(client, task))) : err(notFound('反馈草稿任务不存在'));
    },
    async retry(input) {
      const client = await getClient();
      if (!input.clientRequestId?.trim() || input.clientRequestId.length > 128) return err(validationError('clientRequestId 必填且不超过 128 个字符', 'clientRequestId'));
      let task = await owned(client, input.teacherId, input.taskId);
      if (!task) return err(notFound('反馈草稿任务不存在'));
      task = await reconcileStaleRunning(client, task);
      const existing = await client.feedbackDraftAttempt.findUnique({ where: { taskId_clientRequestId: { taskId: task.id, clientRequestId: input.clientRequestId } } });
      if (existing) return ok({ task: dto(await reconcileStaleRunning(client, task)), replayed: true });
      if (task.version !== input.expectedVersion) return err(versionConflict());
      if (!(task.status === 'failed' && task.retryable) && task.status !== 'uncertain') return err(validationError('当前任务不可重试', 'status'));
      const fingerprintValue = fingerprint({ taskId: task.id, clientRequestId: input.clientRequestId });
      try {
        await client.$transaction(async (tx) => {
          const now = await databaseNow(tx);
          if (!now) throw new Error('TRUSTED_TIME_UNAVAILABLE');
          const claimed = await tx.feedbackDraftTask.updateMany({ where: { id: task.id, teacherId: input.teacherId, version: input.expectedVersion },
            data: { status: 'running', retryable: false, errorCiphertext: null, attemptCount: { increment: 1 }, version: { increment: 1 }, updatedAtTs: now } });
          if (claimed.count !== 1) throw new Error('VERSION_CONFLICT');
          await tx.feedbackDraftAttempt.create({ data: { taskId: task.id, teacherId: input.teacherId, clientRequestId: input.clientRequestId, requestFingerprint: fingerprintValue, status: 'running', createdAtTs: now, updatedAtTs: now } });
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'TRUSTED_TIME_UNAVAILABLE') return err(internalError('数据库可信时间不可用'));
        const replay = await client.feedbackDraftAttempt.findUnique({ where: { taskId_clientRequestId: { taskId: task.id, clientRequestId: input.clientRequestId } } });
        if (replay) return ok({ task: dto((await owned(client, input.teacherId, task.id))!), replayed: true });
        return err(versionConflict());
      }
      return ok({ task: await run(task.id, input.teacherId, input.clientRequestId), replayed: false });
    },
    async updateDraft(input) {
      if (!input.title.trim() || !input.content.trim()) return err(validationError('title 和 content 均不能为空'));
      const client = await getClient(); const task = await owned(client, input.teacherId, input.taskId);
      if (!task) return err(notFound('反馈草稿任务不存在'));
      if (task.version !== input.expectedVersion) return err(versionConflict());
      if (task.status !== 'succeeded') return err(validationError('当前任务没有可编辑的生成草稿', 'status'));
      const now = await taskUpdatedAt(client);
      if (!now) return err(internalError('数据库可信时间不可用'));
      const updated = await client.feedbackDraftTask.updateMany({ where: { id: task.id, teacherId: input.teacherId, version: input.expectedVersion }, data: { draftCiphertext: encryptJsonFieldValue(cipher, { title: input.title, content: input.content }), version: { increment: 1 }, updatedAtTs: now } });
      if (!updated.count) return err(versionConflict());
      const refreshed = await owned(client, input.teacherId, input.taskId);
      return refreshed ? ok(dto(refreshed)) : err(notFound('反馈草稿任务不存在'));
    },
  };
}
