import { describe, expect, it, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import { createTeachingTaskRuntimeWorker } from '../../../src/app/teaching-runtime/teaching-task-runtime-worker.js';
import type { TeachingRuntimeDriver } from '../../../src/app/teaching-runtime/runtime-driver.js';

const unavailable: TeachingRuntimeDriver = {
  availability: 'unavailable', runtimeVersion: 'dsh-v1',
  async run() {
    return { ok: false, error: { code: 'VALIDATION_ERROR', field: 'runtime', message: 'unavailable', retryable: true } };
  },
};

const available: TeachingRuntimeDriver = {
  availability: 'test', runtimeVersion: 'dsh-v1',
  async run() {
    return { ok: true, value: {
      reply: 'unused', sessionRef: 'unused', status: 'succeeded', checkpoint: null,
      cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, synthetic: true },
    } };
  },
};

describe('TeachingTaskRuntimeWorker', () => {
  it('keeps unavailable work pending without claiming through the runner', async () => {
    const run = vi.fn();
    const worker = createTeachingTaskRuntimeWorker({
      driver: unavailable,
      runner: { run },
    });
    expect(worker.wake({ teacherId: 'teacher-a', taskId: 'task-a' })).toMatchObject({ ok: true, value: { queued: true } });
    await expect(worker.runOnce()).resolves.toMatchObject({ ok: true, value: { ran: false, pending: true, status: 'unavailable' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('deduplicates a wake and runs it once when the driver is available', async () => {
    const run = vi.fn(async () => ok({ status: 'succeeded', executionId: 'execution-a' }));
    const worker = createTeachingTaskRuntimeWorker({
      driver: available,
      runner: { run },
    });
    expect(worker.wake({ teacherId: 'teacher-a', taskId: 'task-a' })).toMatchObject({ ok: true, value: { queued: true } });
    expect(worker.wake({ teacherId: 'teacher-a', taskId: 'task-a' })).toMatchObject({ ok: true, value: { queued: false } });
    await expect(worker.runOnce()).resolves.toMatchObject({ ok: true, value: { ran: true, pending: false, status: 'succeeded', executionId: 'execution-a' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ teacherId: 'teacher-a', taskId: 'task-a' });
  });

  it('serializes concurrent runOnce calls without leaving the later wake stranded', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (input: { taskId: string }) => {
      if (input.taskId === 'task-a') await blocked;
      return ok({ status: 'succeeded', executionId: `execution-${input.taskId}` });
    });
    const worker = createTeachingTaskRuntimeWorker({ driver: available, runner: { run } });
    worker.wake({ teacherId: 'teacher-a', taskId: 'task-a' });
    worker.wake({ teacherId: 'teacher-a', taskId: 'task-b' });
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ ok: true, value: { ran: true } });
    await expect(second).resolves.toMatchObject({ ok: true, value: { ran: true, pending: false } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([input]) => input.taskId)).toEqual(['task-a', 'task-b']);
  });
});
