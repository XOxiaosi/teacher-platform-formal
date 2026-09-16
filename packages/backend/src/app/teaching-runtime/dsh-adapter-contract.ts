import type { TeachingRuntimeInput, TeachingRuntimeOutput } from './runtime-driver.js';
import type { TeachingQueryTools } from './teaching-query-tools.js';

export const DSH_PINNED_COMMIT = 'c291e7961a515f6d7af9304e7fd1d257929aef26';
export const DSH_TEACHING_PLUGINS = [
  'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent',
  'session-persistence-jsonl', 'agent-loop',
] as const;

/** This boundary is implemented by the fixed upstream host. It is not an
 * alternative Agent loop. Only the scripted-model host is authorized today. */
export interface DshTeachingHost {
  readonly commit: string;
  readonly model: 'scripted-test-only';
  readonly plugins: readonly string[];
  run(input: {
    sessionId: string;
    executionId: string;
    resume: boolean;
    message: string;
    history: TeachingRuntimeInput['history'];
    tools: TeachingQueryTools;
    signal: AbortSignal;
  }): Promise<DshHostResult>;
}

export interface DshHostResult {
  sessionId: string;
  lastEventSeq: number;
  outcome: 'completed' | 'waiting_input' | 'cancelled' | 'failed' | 'outcome_unknown';
  reply: string | null;
  /** True only when a durable completed turn was read without executing again. */
  replayed: boolean;
  modelCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
}

export interface DshUsageRecord {
  teacherId: string;
  taskId: string;
  executionId: string;
  sessionId: string;
  /** Stable key permits the future durable ledger to reject repeat settlement. */
  eventKey: string;
  replayed: boolean;
  outcome: DshHostResult['outcome'];
  cost: TeachingRuntimeOutput['cost'];
  currencyAmount: null;
}
