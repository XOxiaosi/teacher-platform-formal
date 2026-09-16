import type { CommonError, Result } from '@teacher-platform/contracts';
import type { TeachingQueryTools } from './teaching-query-tools.js';

export interface TeachingRuntimeInput {
  teacherId: string;
  taskId: string;
  executionId: string;
  message: string;
  sessionRef: string | null;
  contextEpoch: number;
  checkpoint: TeachingRuntimeCheckpoint | null;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  tools: TeachingQueryTools;
  signal: AbortSignal;
}

export interface TeachingRuntimeCheckpoint {
  schemaVersion: 1;
  runtimeVersion: 'dsh-v1';
  contextEpoch: number;
  lastEventKey: string;
}

export interface TeachingRuntimeOutput {
  reply: string;
  sessionRef: string;
  status: 'succeeded' | 'waiting_input';
  checkpoint: TeachingRuntimeCheckpoint | null;
  cost: {
    modelCalls: number | null; inputTokens: number | null; outputTokens: number | null;
    toolCalls: number; synthetic: boolean;
    /** Missing provider usage is unknown, never a zero-cost claim. */
    usageStatus?: 'reported' | 'unknown';
  };
}

/** A driver must state whether the saved task can safely be retried. This is
 * persisted as TaskRuntime.lastError; CommonError alone has no retry policy. */
export interface TeachingRuntimeError extends CommonError {
  retryable: boolean;
}

/** Platform port, not another agent loop. Only a verified DSH adapter implements
 * run. Tests may inject an explicitly labelled test adapter; production has no
 * fallback to the previous model/provider route. */
export interface TeachingRuntimeDriver {
  readonly availability: 'unavailable' | 'test' | 'ready';
  readonly runtimeVersion: string;
  run(input: TeachingRuntimeInput): Promise<Result<TeachingRuntimeOutput, TeachingRuntimeError>>;
}

/** The runtime adapter vocabulary is deliberately separate from the persisted
 * TaskRuntime DTO. This one-way mapping prevents a local test adapter from
 * being surfaced as production capability. */
export function toTaskRuntimeAvailability(
  availability: TeachingRuntimeDriver['availability'],
): 'available' | 'unavailable' | 'test_only' {
  if (availability === 'ready') return 'available';
  if (availability === 'test') return 'test_only';
  return 'unavailable';
}

export function createUnavailableTeachingRuntime(): TeachingRuntimeDriver {
  return {
    availability: 'unavailable',
    runtimeVersion: 'dsh-v1',
    async run() {
      return { ok: false, error: { code: 'VALIDATION_ERROR', field: 'runtime', message: 'AI 服务尚未连接。你的消息已保存，可以稍后继续。', retryable: true } };
    },
  };
}
