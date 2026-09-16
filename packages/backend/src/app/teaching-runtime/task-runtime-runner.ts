import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { err, internalError, ok, type CommonError, type Result } from '@teacher-platform/contracts';
import {
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type { TeachingTaskLease, TeachingTaskService } from '../../features/teaching-tasks/types.js';
import { createTeachingQueryTools, type TeachingQueryTools } from './teaching-query-tools.js';
import { createTeachingRegistry } from './create-teaching-registry.js';
import {
  toTaskRuntimeAvailability,
  type TeachingRuntimeCheckpoint,
  type TeachingRuntimeDriver,
  type TeachingRuntimeError,
} from './runtime-driver.js';
import { sourceRefsFromQuery } from '../../features/teaching-tasks/teaching-task-sources.js';

export interface TeachingTaskRuntimeRunnerOptions {
  prisma: PrismaClient;
  getClient?: () => Promise<PrismaClient>;
  tasks: TeachingTaskService;
  driver: TeachingRuntimeDriver;
  cipher?: FieldCipher;
  /** Lease renewal cadence for one run; the timer is cleared before run returns. */
  heartbeatMs?: number;
  scheduler?: RuntimeLeaseScheduler;
}

export interface RuntimeLeaseScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface TeachingTaskRuntimeRunner {
  run(input: { teacherId: string; taskId: string }): Promise<Result<RunValue, CommonError>>;
}

type RunValue = { status: string; executionId: string | null };

type ClaimedExecution = {
  lease: TeachingTaskLease;
  taskId: string;
  executionId: string;
};

const DEFAULT_HEARTBEAT_MS = 15_000;

function createLeaseMonitor(
  tasks: TeachingTaskService,
  lease: TeachingTaskLease,
  heartbeatMs: number,
  scheduler: RuntimeLeaseScheduler,
) {
  const controller = new AbortController();
  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const schedule = () => {
    if (stopped || lost) return;
    timer = scheduler.setTimeout(() => {
      inFlight = heartbeat().finally(() => { inFlight = undefined; });
    }, heartbeatMs);
  };
  const heartbeat = async () => {
    if (stopped || lost) return;
    try {
      const result = await tasks.heartbeat(lease);
      if (!result.ok) {
        lost = true;
        controller.abort();
        return;
      }
    } catch {
      lost = true;
      controller.abort();
      return;
    }
    schedule();
  };
  schedule();
  return {
    signal: controller.signal,
    get lost() { return lost; },
    async stop() {
      stopped = true;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      await inFlight;
    },
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function runtimeFailure(message: string, retryable: boolean): TeachingRuntimeError {
  return { code: 'INTERNAL_ERROR', field: 'runtime', message, retryable };
}

function asTaskError(error: TeachingRuntimeError) {
  return {
    code: error.field ?? error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function queryFailure(error: CommonError, retryable: boolean) {
  return { code: error.field ?? error.code, message: error.message, retryable };
}

function validCheckpoint(
  raw: unknown,
  runtimeVersion: string,
  contextEpoch: number,
): TeachingRuntimeCheckpoint | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<TeachingRuntimeCheckpoint>;
  if (
    candidate.schemaVersion !== 1
    || candidate.runtimeVersion !== runtimeVersion
    || candidate.contextEpoch !== contextEpoch
    || typeof candidate.lastEventKey !== 'string'
  ) return undefined;
  return candidate as TeachingRuntimeCheckpoint;
}

/**
 * Bridges platform-owned fenced leases to a driver. The driver never receives
 * Prisma, credentials, arbitrary DSH plugins, or another task's conversation.
 */
export function createTeachingTaskRuntimeRunner(options: TeachingTaskRuntimeRunnerOptions): TeachingTaskRuntimeRunner {
  const getClient = options.getClient ?? (async () => options.prisma);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const scheduler = options.scheduler ?? { setTimeout, clearTimeout };
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) {
    throw new Error('heartbeatMs 必须为正整数');
  }

  async function finishFailure(
    claimed: ClaimedExecution,
    error: TeachingRuntimeError,
  ): Promise<Result<RunValue, CommonError>> {
    try {
      const finished = await options.tasks.finish({
        ...claimed.lease,
        executionId: claimed.executionId,
        status: 'failed',
        error: asTaskError(error),
      });
      if (!finished.ok) return err(internalError('运行失败状态未能在有效租约内保存'));
      return err(error);
    } catch {
      return err(internalError('运行失败状态未能在有效租约内保存'));
    }
  }

  function stepBoundTools(
    base: TeachingQueryTools,
    claimed: ClaimedExecution,
  ): TeachingQueryTools {
    return {
      definitions: base.definitions,
      async execute(name, args) {
        const fingerprint = hash({ name, args });
        // Fresh teaching facts are scoped to one execution. A process retry
        // within that execution reuses the receipt; a later user message gets
        // a new execution and must query the current source of truth again.
        const stepKey = `query:${claimed.executionId}:${name}:${fingerprint}`;
        const prepared = await options.tasks.prepareStep({
          ...claimed.lease,
          executionId: claimed.executionId,
          stepKey,
          inputFingerprint: fingerprint,
          kind: 'query',
          sourceRefs: [],
        });
        if (!prepared.ok) return err(prepared.error);
        if (prepared.value.status === 'succeeded') return ok(prepared.value.result);
        if (prepared.value.status !== 'running') {
          return err(internalError('查询步骤不能在当前租约内执行'));
        }
        try {
          const result = await base.execute(name, args);
          if (!result.ok) {
            const failed = await options.tasks.failStep({
              ...claimed.lease,
              executionId: claimed.executionId,
              stepKey,
              error: queryFailure(result.error, false),
            });
            return failed.ok ? err(result.error) : err(failed.error);
          }
          const sourceRefs = sourceRefsFromQuery(name, args, result.value);
          const completed = await options.tasks.completeStep({
            ...claimed.lease,
            executionId: claimed.executionId,
            stepKey,
            result: result.value,
            sourceRefs,
          });
          return completed.ok ? ok(completed.value.result) : err(completed.error);
        } catch {
          const failed = await options.tasks.failStep({
            ...claimed.lease,
            executionId: claimed.executionId,
            stepKey,
            error: { code: 'QUERY_EXCEPTION', message: '教学查询执行异常，结果状态不确定', retryable: true },
            status: 'uncertain',
          });
          return err(failed.ok
            ? internalError('教学查询执行异常，结果状态不确定')
            : failed.error);
        }
      },
    };
  }

  async function persistCheckpoint(
    claimed: ClaimedExecution,
    output: { sessionRef: string; checkpoint: TeachingRuntimeCheckpoint | null },
  ): Promise<Result<void, CommonError>> {
    try {
      await (await getClient()).$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ now: Date }>>(
          Prisma.sql`SELECT clock_timestamp() AS "now"`,
        );
        const now = rows[0]?.now;
        if (!(now instanceof Date)) throw new Error('CLOCK');
        const current = await tx.taskRuntime.updateMany({
          where: {
            id: claimed.taskId,
            teacherId: claimed.lease.teacherId,
            leaseToken: claimed.lease.leaseToken,
            leaseEpoch: claimed.lease.leaseEpoch,
            leaseExpiresAtTs: { gt: now },
            currentExecutionId: claimed.executionId,
          },
          data: {
            dshSessionRef: output.sessionRef,
            dshCheckpoint: output.checkpoint
              ? encryptJsonFieldValue(options.cipher!, output.checkpoint) as unknown as Prisma.InputJsonValue
              : Prisma.DbNull,
            updatedAtTs: now,
          },
        });
        if (current.count !== 1) throw new Error('FENCED');
      });
      return ok(undefined);
    } catch {
      return err(internalError('运行检查点未能在有效租约内保存'));
    }
  }

  return {
    async run(input: { teacherId: string; taskId: string }): Promise<Result<RunValue, CommonError>> {
      if (toTaskRuntimeAvailability(options.driver.availability) === 'unavailable') {
        return ok({ status: 'unavailable', executionId: null });
      }
      if (!options.cipher) {
        return err(internalError('SAFETY_BLOCK: 缺少 ENCRYPTION_KEY，拒绝运行教学任务'));
      }
      const claimedResult = await options.tasks.claim(input);
      if (!claimedResult.ok) return claimedResult;
      if ('unavailable' in claimedResult.value) {
        return ok({ status: 'unavailable', executionId: claimedResult.value.task.currentExecutionId });
      }
      const claimed: ClaimedExecution = {
        lease: claimedResult.value.lease,
        taskId: claimedResult.value.task.id,
        executionId: claimedResult.value.task.currentExecutionId ?? '',
      };
      if (!claimed.executionId) return err(internalError('教学任务执行快照不存在'));

      const monitor = createLeaseMonitor(options.tasks, claimed.lease, heartbeatMs, scheduler);
      const failed = async (error: TeachingRuntimeError): Promise<Result<RunValue, CommonError>> => {
        await monitor.stop();
        return monitor.lost
          ? err(internalError('教学任务租约已丢失，已停止运行且未写入完成状态'))
          : finishFailure(claimed, error);
      };

      try {
        const db = await getClient();
        const snapshot = await db.taskRuntime.findFirst({
          where: {
            id: claimed.taskId,
            teacherId: input.teacherId,
            currentExecutionId: claimed.executionId,
          },
          include: {
            conversation: {
              include: {
                turns: {
                  where: {
                    teacherId: input.teacherId,
                    redactedAtTs: null,
                    invalidatedAtTs: null,
                  },
                  orderBy: { seq: 'asc' },
                },
              },
            },
          },
        });
        if (!snapshot) {
          return failed(runtimeFailure('教学任务执行快照不存在', true));
        }
        const execution = await db.agentExecution.findFirst({
          where: {
            id: claimed.executionId,
            taskId: snapshot.id,
            teacherId: input.teacherId,
          },
        });
        if (!execution?.userTurnId) {
          return failed(runtimeFailure('教学任务原消息不存在', true));
        }
        const userTurn = snapshot.conversation.turns.find((turn) => turn.id === execution.userTurnId);
        if (!userTurn) {
          return failed(runtimeFailure('教学任务原消息不存在', true));
        }
        let checkpoint: TeachingRuntimeCheckpoint | null;
        try {
          if (snapshot.runtimeVersion !== 'dsh-v1' || options.driver.runtimeVersion !== snapshot.runtimeVersion) {
            throw new Error('runtime-version');
          }
          const candidate = validCheckpoint(
            decryptJsonFieldValue(options.cipher, snapshot.dshCheckpoint),
            snapshot.runtimeVersion,
            snapshot.contextEpoch,
          );
          if (candidate === undefined) throw new Error('checkpoint-shape');
          checkpoint = candidate;
        } catch {
          return failed({
            code: 'VALIDATION_ERROR',
            field: 'checkpoint',
            message: '运行检查点无效，不能安全续接，请重建任务上下文。',
            retryable: true,
          });
        }
        // Snapshot reads can outlast a heartbeat. Do not hand an already-aborted
        // lease to a driver that would otherwise begin model work or await a
        // future abort event that has already happened.
        if (monitor.lost) return failed(runtimeFailure('教学任务租约已丢失，拒绝启动运行器', false));
        const registry = createTeachingRegistry(getClient);
        const output = await options.driver.run({
          teacherId: input.teacherId,
          taskId: snapshot.id,
          executionId: execution.id,
          message: decryptFieldValue(options.cipher, userTurn.content),
          sessionRef: snapshot.dshSessionRef,
          contextEpoch: snapshot.contextEpoch,
          checkpoint,
          history: snapshot.conversation.turns
            .filter((turn) => turn.taskId === snapshot.id
              && (turn.role === 'user' || turn.role === 'assistant'))
            .map((turn) => ({
              role: turn.role as 'user' | 'assistant',
              content: decryptFieldValue(options.cipher!, turn.content),
            })),
          tools: stepBoundTools(
            createTeachingQueryTools(registry, input.teacherId),
            claimed,
          ),
          signal: monitor.signal,
        });
        await monitor.stop();
        if (monitor.lost) {
          return err(internalError('教学任务租约已丢失，已停止运行且未写入完成状态'));
        }
        if (!output.ok) return finishFailure(claimed, output.error);
        const outputCheckpoint = validCheckpoint(
          output.value.checkpoint,
          snapshot.runtimeVersion,
          snapshot.contextEpoch,
        );
        if (outputCheckpoint === undefined) {
          return finishFailure(claimed, {
            code: 'VALIDATION_ERROR',
            field: 'checkpoint',
            message: '运行器返回的检查点与当前任务不匹配，拒绝保存。',
            retryable: true,
          });
        }
        const persisted = await persistCheckpoint(claimed, output.value);
        if (!persisted.ok) return persisted;
        const finished = await options.tasks.finish({
          ...claimed.lease,
          executionId: claimed.executionId,
          status: output.value.status,
          reply: output.value.reply,
        });
        return finished.ok
          ? ok({ status: output.value.status, executionId: claimed.executionId })
          : err(finished.error);
      } catch {
        await monitor.stop();
        return monitor.lost
          ? err(internalError('教学任务租约已丢失，已停止运行且未写入完成状态'))
          : finishFailure(claimed, runtimeFailure('教学运行发生未处理异常', true));
      }
    },
  };
}
