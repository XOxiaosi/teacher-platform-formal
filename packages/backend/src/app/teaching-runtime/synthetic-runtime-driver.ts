import { err, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { TeachingRuntimeDriver, TeachingRuntimeInput, TeachingRuntimeOutput } from './runtime-driver.js';

const AUDITED_QUERY_NAMES = new Set([
  'students.get', 'students.list', 'students.balance', 'scheduling.list',
  'lessons.list', 'payments.list', 'feedback.list', 'memos.list',
]);

export type SyntheticRuntimeAction =
  | { type: 'query'; tool: string; args: Record<string, unknown> }
  | { type: 'reply'; content: string }
  | { type: 'pause' }
  | { type: 'fail'; code: string; message: string; retryable: boolean };

export interface SyntheticRuntimePlan {
  readonly actions: readonly SyntheticRuntimeAction[];
}

function error(code: string, message: string): Result<TeachingRuntimeOutput, CommonError> {
  return err({ code: 'VALIDATION_ERROR', field: code, message });
}

/** Test-only local adapter. It cannot load DSH plugins, invoke a model, open a
 * workspace, or accept a tool name outside TeachingQueryTools. */
export function createSyntheticTeachingRuntime(plan: SyntheticRuntimePlan): TeachingRuntimeDriver {
  return {
    availability: 'test',
    runtimeVersion: 'dsh-v1-synthetic',
    async run(input: TeachingRuntimeInput): Promise<Result<TeachingRuntimeOutput, CommonError>> {
      if (input.signal.aborted) return error('RUNTIME_CANCELLED', '教学任务已暂停');
      let reply: string | null = null;
      let toolCalls = 0;
      for (const action of plan.actions) {
        if (input.signal.aborted) return error('RUNTIME_CANCELLED', '教学任务已暂停');
        if (action.type === 'query') {
          const definition = input.tools.definitions.find((tool) => tool.name === action.tool);
          if (!AUDITED_QUERY_NAMES.has(action.tool) || !definition || definition.sideEffect !== 'read' || definition.confirmation === 'required') {
            return err(validationError('当前教学助手不支持这项操作', 'tool'));
          }
          const result = await input.tools.execute(action.tool, action.args);
          if (!result.ok) return err(result.error);
          toolCalls++;
          continue;
        }
        if (action.type === 'pause') {
          return ok({ reply: reply ?? '需要补充信息后才能继续。', sessionRef: input.sessionRef ?? `synthetic:${input.taskId}`, status: 'waiting_input', checkpoint: { schemaVersion: 1, contextEpoch: input.contextEpoch, lastEventKey: `execution:${input.executionId}:pause` }, cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls, synthetic: true } });
        }
        if (action.type === 'fail') return error(action.code, action.message);
        reply = action.content;
      }
      if (!reply) return err(validationError('synthetic plan 缺少回复', 'plan'));
      return ok({ reply, sessionRef: input.sessionRef ?? `synthetic:${input.taskId}`, status: 'succeeded', checkpoint: { schemaVersion: 1, contextEpoch: input.contextEpoch, lastEventKey: `execution:${input.executionId}:complete` }, cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls, synthetic: true } });
    },
  };
}
