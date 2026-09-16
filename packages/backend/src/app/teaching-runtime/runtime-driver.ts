import type { CommonError, Result } from '@teacher-platform/contracts';
import type { TeachingQueryTools } from './teaching-query-tools.js';

export interface TeachingRuntimeInput {
  teacherId: string;
  taskId: string;
  executionId: string;
  message: string;
  sessionRef: string | null;
  contextEpoch: number;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  tools: TeachingQueryTools;
  signal: AbortSignal;
}

export interface TeachingRuntimeOutput {
  reply: string;
  sessionRef: string;
  status: 'succeeded' | 'waiting_input';
  checkpoint: { schemaVersion: 1; contextEpoch: number; lastEventKey: string } | null;
  cost: { modelCalls: number; inputTokens: number; outputTokens: number; toolCalls: number; synthetic: boolean };
}

/** Platform port, not another agent loop. Only a verified DSH adapter implements
 * run. Tests may inject an explicitly labelled test adapter; production has no
 * fallback to the previous model/provider route. */
export interface TeachingRuntimeDriver {
  readonly availability: 'unavailable' | 'test' | 'ready';
  readonly runtimeVersion: string;
  run(input: TeachingRuntimeInput): Promise<Result<TeachingRuntimeOutput, CommonError>>;
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
      return { ok: false, error: { code: 'VALIDATION_ERROR', field: 'runtime', message: 'AI 服务尚未连接。你的消息已保存，可以稍后继续。' } };
    },
  };
}
