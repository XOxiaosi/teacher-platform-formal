import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { err } from '@teacher-platform/contracts';
import { createTeachingTaskRuntimeRunner } from '../../../src/app/teaching-runtime/task-runtime-runner.js';
import { createSyntheticTeachingRuntime } from '../../../src/app/teaching-runtime/synthetic-runtime-driver.js';
import { createUnavailableTeachingRuntime, type TeachingRuntimeDriver } from '../../../src/app/teaching-runtime/runtime-driver.js';
import { createTeachingTaskService } from '../../../src/features/teaching-tasks/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

const TEACHER = 'a02-runner-teacher';
const cipher = createFieldCipher(loadEncryptionKey().key);
let database: IsolatedPostgres | undefined;
let prisma: PrismaClient;

beforeAll(async () => { database = await createIsolatedPostgres(); prisma = database.prisma; });
afterAll(async () => { await database?.cleanup(); });
beforeEach(async () => {
  await prisma.conversationTurn.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.stepReceipt.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.agentExecution.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.conversation.deleteMany({ where: { teacherId: TEACHER } });
});

async function received() {
  const tasks = createTeachingTaskService({ prisma, cipher, runtimeAvailability: 'test_only' });
  const conversation = await tasks.createConversation({ teacherId: TEACHER });
  if (!conversation.ok) throw new Error(conversation.error.message);
  const receipt = await tasks.receiveMessage({ teacherId: TEACHER, conversationId: conversation.value.id, clientRequestId: `a02-runner-${Date.now()}`, message: '请继续教学任务' });
  if (!receipt.ok) throw new Error(receipt.error.message);
  return { tasks, taskId: receipt.value.task.id, executionId: receipt.value.receipt.executionId };
}

async function continueTask(
  tasks: ReturnType<typeof createTeachingTaskService>,
  taskId: string,
  message: string,
  clientRequestId: string,
) {
  const detail = await tasks.getTask({ teacherId: TEACHER, taskId });
  if (!detail.ok) throw new Error(detail.error.message);
  const receipt = await tasks.receiveMessage({
    teacherId: TEACHER,
    conversationId: detail.value.task.conversationId,
    taskId,
    expectedVersion: detail.value.task.version,
    clientRequestId,
    message,
  });
  if (!receipt.ok) throw new Error(receipt.error.message);
  return receipt.value;
}

describe('A02 TeachingTaskRuntimeRunner PostgreSQL lifecycle', () => {
  it('persists a server session reference and encrypted checkpoint before finish', async () => {
    const value = await received();
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver: createSyntheticTeachingRuntime({ actions: [{ type: 'reply', content: '已完成合成教学查询。' }] }) });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: true, value: { status: 'succeeded', executionId: value.executionId } });
    const task = await prisma.taskRuntime.findUnique({ where: { id: value.taskId } });
    expect(task).toMatchObject({ status: 'succeeded', dshSessionRef: `synthetic:${value.taskId}` });
    expect(typeof task?.dshCheckpoint).toBe('string');
    expect(String(task?.dshCheckpoint)).toMatch(/^enc:v1:/);
  });

  it('finishes waiting_input and driver failures without fabricating success', async () => {
    const paused = await received();
    const pauseRunner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: paused.tasks, driver: createSyntheticTeachingRuntime({ actions: [{ type: 'pause' }] }) });
    await expect(pauseRunner.run({ teacherId: TEACHER, taskId: paused.taskId })).resolves.toMatchObject({ ok: true, value: { status: 'waiting_input' } });
    expect((await prisma.taskRuntime.findUnique({ where: { id: paused.taskId } }))?.status).toBe('waiting_input');
    const failed = await received();
    const failing: TeachingRuntimeDriver = { availability: 'test', runtimeVersion: 'dsh-v1', run: async () => err({ code: 'VALIDATION_ERROR', field: 'UPSTREAM_TIMEOUT', message: 'timeout', retryable: true }) };
    const failingRunner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: failed.tasks, driver: failing });
    await expect(failingRunner.run({ teacherId: TEACHER, taskId: failed.taskId })).resolves.toMatchObject({ ok: false, error: { field: 'UPSTREAM_TIMEOUT' } });
    expect((await prisma.taskRuntime.findUnique({ where: { id: failed.taskId } }))?.status).toBe('failed');
  });

  it('rebuilds a runner and passes the persisted checkpoint only after version validation', async () => {
    const value = await received();
    const first = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver: createSyntheticTeachingRuntime({ actions: [{ type: 'pause' }] }) });
    await expect(first.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: true, value: { status: 'waiting_input' } });
    const continued = await continueTask(value.tasks, value.taskId, '请根据之前结果继续。', 'a02-checkpoint-continue');
    const seen = vi.fn();
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async (input) => { seen(input.checkpoint); return { ok: true, value: { reply: '恢复完成', sessionRef: input.sessionRef ?? 'missing', status: 'succeeded', checkpoint: input.checkpoint, cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, synthetic: true } } }; },
    };
    const rebuilt = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver });
    await expect(rebuilt.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: true, value: { status: 'succeeded', executionId: continued.receipt.executionId } });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: 0 }));
  });

  it('fails closed before driver execution when checkpoint ciphertext is invalid', async () => {
    const value = await received();
    await prisma.taskRuntime.update({ where: { id: value.taskId }, data: { dshCheckpoint: 'enc:v1:not-a-valid-checkpoint' } });
    const driver = createSyntheticTeachingRuntime({ actions: [{ type: 'reply', content: '不得执行' }] });
    const run = vi.spyOn(driver, 'run');
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: false, error: { field: 'checkpoint' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a driver checkpoint with the wrong runtime identity before persistence', async () => {
    const value = await received();
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async () => ({
        ok: true,
        value: {
          reply: '不得保存',
          sessionRef: 'wrong-checkpoint',
          status: 'succeeded',
          checkpoint: { schemaVersion: 1, runtimeVersion: 'other-runtime' as 'dsh-v1', contextEpoch: 0, lastEventKey: 'wrong' },
          cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, synthetic: true },
        },
      }),
    };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId }))
      .resolves.toMatchObject({ ok: false, error: { field: 'checkpoint' } });
    expect(await prisma.taskRuntime.findUnique({ where: { id: value.taskId } }))
      .toMatchObject({ dshSessionRef: null, dshCheckpoint: null, status: 'failed' });
  });

  it('does not pass another task history from the same conversation to a driver', async () => {
    const first = await received();
    const firstTask = await prisma.taskRuntime.findUniqueOrThrow({ where: { id: first.taskId } });
    const second = await first.tasks.receiveMessage({ teacherId: TEACHER, conversationId: firstTask.conversationId, clientRequestId: 'a02-history-second', message: '第二个任务的资料' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const seen = vi.fn();
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async (input) => { seen(input.history); return { ok: true, value: { reply: '完成', sessionRef: 'second-session', status: 'succeeded', checkpoint: { schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: 0, lastEventKey: 'second' }, cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, synthetic: true } } }; },
    };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: first.tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: second.value.task.id })).resolves.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(seen).toHaveBeenCalledWith([{ role: 'user', content: '第二个任务的资料' }]);
  });

  it('refuses to persist a result when the driver lets its lease expire', async () => {
    const value = await received();
    const expiring: TeachingRuntimeDriver = { availability: 'test', runtimeVersion: 'dsh-v1', run: async () => {
      await prisma.taskRuntime.update({ where: { id: value.taskId }, data: { leaseExpiresAtTs: new Date(0) } });
      return { ok: true, value: { reply: 'late', sessionRef: 'late-session', status: 'succeeded', checkpoint: { schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: 0, lastEventKey: 'late' }, cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, synthetic: true } } };
    } };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver: expiring });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: false });
    expect((await prisma.taskRuntime.findUnique({ where: { id: value.taskId } }))?.dshSessionRef).toBeNull();
  });

  it('production unavailable does not claim or invoke a driver', async () => {
    const tasks = createTeachingTaskService({ prisma, cipher, runtimeAvailability: 'unavailable' });
    const conversation = await tasks.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);
    const receipt = await tasks.receiveMessage({ teacherId: TEACHER, conversationId: conversation.value.id, clientRequestId: 'a02-unavailable-001', message: '保存但不可调用模型' });
    if (!receipt.ok) throw new Error(receipt.error.message);
    const driver = createUnavailableTeachingRuntime();
    const run = vi.spyOn(driver, 'run');
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: receipt.value.task.id })).resolves.toMatchObject({ ok: true, value: { status: 'unavailable' } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('A02 TeachingTaskRuntimeRunner failure and query receipts', () => {
  it.each([false, true])('persists driver retryable=%s and only permits matching resume policy', async (retryable) => {
    const value = await received();
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async () => err({ code: 'VALIDATION_ERROR', field: 'DRIVER_FAILURE', message: 'driver failure', retryable }),
    };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: false, error: { field: 'DRIVER_FAILURE' } });
    const detail = await value.tasks.getTask({ teacherId: TEACHER, taskId: value.taskId });
    expect(detail).toMatchObject({ ok: true, value: { task: { status: 'failed', lastError: { retryable }, canResume: retryable } } });
    if (!detail.ok) return;
    const resumed = await value.tasks.resume({
      teacherId: TEACHER,
      taskId: value.taskId,
      executionId: value.executionId,
      expectedVersion: detail.value.task.version,
    });
    expect(resumed.ok).toBe(retryable);
  });

  it('contains a rejected driver promise, persists failed status, and does not throw', async () => {
    const value = await received();
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async () => { throw new Error('driver rejected'); },
    };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: false });
    const detail = await value.tasks.getTask({ teacherId: TEACHER, taskId: value.taskId });
    expect(detail).toMatchObject({ ok: true, value: { task: { status: 'failed', lastError: { retryable: true } } } });
  });

  it('runs a fresh query receipt for a new execution after runner recreation', async () => {
    const value = await received();
    const plan = { actions: [
      { type: 'query' as const, tool: 'students.list', args: {} },
      { type: 'pause' as const },
    ] };
    const firstDriver = createSyntheticTeachingRuntime(plan);
    const first = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver: firstDriver });
    await expect(first.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: true, value: { status: 'waiting_input' } });
    const initialStep = await prisma.stepReceipt.findFirstOrThrow({ where: { taskId: value.taskId } });
    expect(initialStep.status).toBe('succeeded');
    const firstEvents = await value.tasks.listTaskEvents({ teacherId: TEACHER, taskId: value.taskId });
    expect(firstEvents).toMatchObject({ ok: true });
    if (firstEvents.ok) expect(firstEvents.value.items.some((event) => event.eventKind === 'step_result')).toBe(true);

    const continued = await continueTask(value.tasks, value.taskId, '继续检查相同学生列表。', 'a02-query-continue');
    const secondDriver = createSyntheticTeachingRuntime(plan);
    const execute = vi.spyOn(secondDriver, 'run');
    const second = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver: secondDriver });
    await expect(second.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: true, value: { status: 'waiting_input' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(continued.receipt.executionId).not.toBe(value.executionId);
    const steps = await prisma.stepReceipt.findMany({ where: { taskId: value.taskId }, orderBy: { createdAtTs: 'asc' } });
    expect(steps).toHaveLength(2);
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: initialStep.id, status: 'succeeded', executionId: value.executionId, attemptCount: 1 }),
      expect.objectContaining({ status: 'succeeded', executionId: continued.receipt.executionId, attemptCount: 1 }),
    ]));
  });

  it('reuses a succeeded query receipt only within the same execution', async () => {
    const value = await received();
    const claimed = await value.tasks.claim({ teacherId: TEACHER, taskId: value.taskId });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || 'unavailable' in claimed.value) return;
    const stepKey = `query:${value.executionId}:students.list:manual`;
    const prepared = await value.tasks.prepareStep({
      ...claimed.value.lease,
      executionId: value.executionId,
      stepKey,
      inputFingerprint: 'manual-fingerprint',
      kind: 'query',
      sourceRefs: [],
    });
    expect(prepared).toMatchObject({ ok: true, value: { status: 'running' } });
    const completed = await value.tasks.completeStep({
      ...claimed.value.lease,
      executionId: value.executionId,
      stepKey,
      result: { students: [] },
    });
    expect(completed).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    const replayed = await value.tasks.prepareStep({
      ...claimed.value.lease,
      executionId: value.executionId,
      stepKey,
      inputFingerprint: 'manual-fingerprint',
      kind: 'query',
      sourceRefs: [],
    });
    expect(replayed).toMatchObject({ ok: true, value: { id: completed.ok ? completed.value.id : '', status: 'succeeded' } });
    expect(await prisma.stepReceipt.findFirstOrThrow({ where: { taskId: value.taskId, stepKey } }))
      .toMatchObject({ status: 'succeeded', executionId: value.executionId, attemptCount: 1 });
  });

  it('does not execute a query after its lease becomes invalid', async () => {
    const value = await received();
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async (input) => {
        await prisma.taskRuntime.update({ where: { id: value.taskId }, data: { leaseExpiresAtTs: new Date(0) } });
        const result = await input.tools.execute('students.list', {});
        return result.ok
          ? err({ code: 'INTERNAL_ERROR', field: 'lease', message: 'should not query', retryable: true })
          : err({ ...result.error, retryable: true });
      },
    };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks: value.tasks, driver });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId })).resolves.toMatchObject({ ok: false });
    expect(await prisma.stepReceipt.count({ where: { taskId: value.taskId } })).toBe(0);
  });
});

describe('A02 TeachingTaskRuntimeRunner lease heartbeat', () => {
  it('renews the claimed lease while a driver is still running', async () => {
    const value = await received();
    const heartbeat = vi.spyOn(value.tasks, 'heartbeat');
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async (input) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 35));
        return {
          ok: true,
          value: {
            reply: '长任务已完成', sessionRef: 'heartbeat-session', status: 'succeeded', checkpoint: {
              schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: input.contextEpoch, lastEventKey: 'heartbeat',
            }, cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, synthetic: true },
          },
        };
      },
    };
    const runner = createTeachingTaskRuntimeRunner({
      prisma, cipher, tasks: value.tasks, driver, heartbeatMs: 5,
    });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId }))
      .resolves.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(heartbeat).toHaveBeenCalled();
  });

  it('aborts a driver after lease loss and never finishes the task', async () => {
    const value = await received();
    vi.spyOn(value.tasks, 'heartbeat').mockResolvedValueOnce(
      err({ code: 'VERSION_CONFLICT', field: 'lease', message: 'lease lost' }),
    );
    const finish = vi.spyOn(value.tasks, 'finish');
    const driver: TeachingRuntimeDriver = {
      availability: 'test', runtimeVersion: 'dsh-v1',
      run: async (input) => new Promise((resolve) => {
        input.signal.addEventListener('abort', () => resolve(err({
          code: 'VALIDATION_ERROR', field: 'runtime', message: 'aborted after lease loss', retryable: true,
        })), { once: true });
      }),
    };
    const runner = createTeachingTaskRuntimeRunner({
      prisma, cipher, tasks: value.tasks, driver, heartbeatMs: 5,
    });
    await expect(runner.run({ teacherId: TEACHER, taskId: value.taskId }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(finish).not.toHaveBeenCalled();
    expect(await prisma.taskRuntime.findUnique({ where: { id: value.taskId } }))
      .toMatchObject({ status: 'running' });
  });
});
