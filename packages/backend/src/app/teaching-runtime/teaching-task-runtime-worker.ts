import { err, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import {
  createTeachingTaskRuntimeRunner,
  type TeachingTaskRuntimeRunner,
  type TeachingTaskRuntimeRunnerOptions,
} from './task-runtime-runner.js';
import { toTaskRuntimeAvailability, type TeachingRuntimeDriver } from './runtime-driver.js';

export interface TeachingTaskRuntimeWake {
  teacherId: string;
  taskId: string;
}

export interface TeachingTaskRuntimeWorkerOptions {
  /** The availability gate is checked before the worker calls runner.run. */
  driver: TeachingRuntimeDriver;
  /** Injected by production composition or a focused worker test. */
  runner?: TeachingTaskRuntimeRunner;
  /** Used only when runner is not injected. No timer or network starts here. */
  runnerOptions?: Omit<TeachingTaskRuntimeRunnerOptions, 'driver'>;
}

export interface TeachingTaskRuntimeWorker {
  readonly availability: TeachingRuntimeDriver['availability'];
  wake(input: TeachingTaskRuntimeWake): Result<{ queued: boolean }, CommonError>;
  runOnce(): Promise<Result<{
    ran: boolean;
    pending: boolean;
    status?: string;
    executionId?: string | null;
  }, CommonError>>;
}

function key(input: TeachingTaskRuntimeWake): string {
  return `${input.teacherId}:${input.taskId}`;
}

/**
 * Explicit process-local dispatcher for a host worker. It deliberately owns no
 * background loop: composition, a queue consumer, or a test calls runOnce.
 * The TaskRuntime row remains the durable source of queued work.
 */
export function createTeachingTaskRuntimeWorker(
  options: TeachingTaskRuntimeWorkerOptions,
): TeachingTaskRuntimeWorker {
  const runner = options.runner ?? (options.runnerOptions
    ? createTeachingTaskRuntimeRunner({ ...options.runnerOptions, driver: options.driver })
    : undefined);
  if (!runner) throw new Error('TeachingTaskRuntimeWorker 需要 runner 或 runnerOptions');
  const taskRunner = runner;
  const pending = new Map<string, TeachingTaskRuntimeWake>();
  type RunResult = Result<{
    ran: boolean; pending: boolean; status?: string; executionId?: string | null;
  }, CommonError>;
  let activeRun: Promise<RunResult> | null = null;

  async function runNext(): Promise<RunResult> {
    const next = pending.values().next().value as TeachingTaskRuntimeWake | undefined;
    if (!next) return ok({ ran: false, pending: false });
    // Do not dequeue or claim an unavailable task. A later availability
    // transition can safely process the same durable task after another wake.
    if (toTaskRuntimeAvailability(options.driver.availability) === 'unavailable') {
      return ok({ ran: false, pending: true, status: 'unavailable' });
    }
    pending.delete(key(next));
    const result = await taskRunner.run(next);
    if (!result.ok) return err(result.error);
    return ok({
      ran: true,
      pending: pending.size > 0,
      status: result.value.status,
      executionId: result.value.executionId,
    });
  }

  return {
    availability: options.driver.availability,
    wake(input) {
      if (!input.teacherId.trim()) return err(validationError('teacherId 不能为空', 'teacherId'));
      if (!input.taskId.trim()) return err(validationError('taskId 不能为空', 'taskId'));
      const requestKey = key(input);
      const queued = !pending.has(requestKey);
      pending.set(requestKey, { teacherId: input.teacherId, taskId: input.taskId });
      return ok({ queued });
    },

    async runOnce() {
      const previous = activeRun;
      const current = (async () => {
        if (previous) await previous;
        return runNext();
      })();
      activeRun = current;
      try {
        return await current;
      } finally {
        if (activeRun === current) activeRun = null;
      }
    },
  };
}
