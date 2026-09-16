import { createHash } from 'node:crypto';
import { err, ok, validationError } from '@teacher-platform/contracts';
import type { TeachingRuntimeDriver, TeachingRuntimeError, TeachingRuntimeInput } from './runtime-driver.js';
import { DSH_PINNED_COMMIT, DSH_TEACHING_PLUGINS, type DshTeachingHost, type DshUsageRecord } from './dsh-adapter-contract.js';

const QUERIES = new Set([
  'students.get', 'students.list', 'students.balance', 'scheduling.list',
  'lessons.list', 'payments.list', 'feedback.list', 'memos.list',
]);
const failure = (field: string, message: string, retryable = false) => err<TeachingRuntimeError>({
  code: 'VALIDATION_ERROR', field, message, retryable,
});
const counter = (value: number | null) => value === null || Number.isSafeInteger(value) && value >= 0;

export function dshTeachingSessionId(input: Pick<TeachingRuntimeInput, 'teacherId' | 'taskId' | 'contextEpoch'>): string {
  return `teaching-${createHash('sha256').update(JSON.stringify([input.teacherId, input.taskId, input.contextEpoch])).digest('hex')}`;
}

/** Explicitly test-only until DeepSeek transport, persistent budgets and data
 * retention are authorized and verified. Never reads environment or old keys. */
export function createDshTeachingRuntime(options: {
  host: DshTeachingHost;
  onUsage: (record: DshUsageRecord) => Promise<void>;
}): TeachingRuntimeDriver {
  const { host } = options;
  if (host.commit !== DSH_PINNED_COMMIT || host.model !== 'scripted-test-only'
    || [...host.plugins].sort().join('|') !== [...DSH_TEACHING_PLUGINS].sort().join('|')) {
    throw new Error('DSH_PIN_OR_PROFILE_MISMATCH');
  }
  return {
    availability: 'test', runtimeVersion: 'dsh-v1',
    async run(input) {
      const sessionId = dshTeachingSessionId(input);
      if (!input.teacherId.trim() || !input.taskId.trim() || !input.executionId.trim()
        || !Number.isSafeInteger(input.contextEpoch) || input.contextEpoch < 0) {
        return failure('DSH_IDENTITY_INVALID', '教学任务身份无效');
      }
      if (input.sessionRef !== null && input.sessionRef !== sessionId) {
        return failure('DSH_SESSION_MISMATCH', '教学任务上下文已变更，需要重新整理');
      }
      const checkpoint = input.checkpoint;
      if (checkpoint && (!input.sessionRef || checkpoint.schemaVersion !== 1
        || checkpoint.runtimeVersion !== 'dsh-v1' || checkpoint.contextEpoch !== input.contextEpoch
        || !new RegExp(`^${sessionId}:event:[0-9]+$`).test(checkpoint.lastEventKey))) {
        return failure('DSH_CHECKPOINT_INVALID', '教学任务恢复信息不匹配');
      }
      if (input.signal.aborted) return failure('DSH_CANCELLED', '教学任务已暂停', true);
      const definitions = input.tools.definitions.filter(tool => QUERIES.has(tool.name)
        && tool.sideEffect === 'read' && tool.confirmation !== 'required').map(tool => structuredClone(tool));
      const exposed = new Set(definitions.map(tool => tool.name));
      let denied = false;
      let toolCalls = 0;
      const tools = {
        definitions,
        async execute(name: string, args: unknown) {
          const current = input.tools.definitions.find(tool => tool.name === name);
          if (input.signal.aborted || !exposed.has(name) || !current || current.sideEffect !== 'read'
            || current.confirmation === 'required' || !args || typeof args !== 'object' || Array.isArray(args)
            || ['teacherId', 'prisma', 'credentials', 'apiKey'].some(key => Object.hasOwn(args, key))) {
            denied = true;
            return err(validationError('教学查询未获授权', 'tool'));
          }
          toolCalls++;
          const result = await input.tools.execute(name, args);
          if (!result.ok) denied = true;
          return result;
        },
      };
      let usageAttempted = false;
      const reportUnknownUsage = async () => {
        usageAttempted = true;
        // Use only platform-owned identity and locally observed tool attempts.
        // An invalid host result cannot supply a safe event key or usage total.
        await options.onUsage({ teacherId: input.teacherId, taskId: input.taskId, executionId: input.executionId,
          sessionId, eventKey: `${sessionId}:execution:${input.executionId}:unknown`, replayed: false,
          outcome: 'outcome_unknown', currencyAmount: null,
          cost: { modelCalls: null, inputTokens: null, outputTokens: null, toolCalls, synthetic: true, usageStatus: 'unknown' } });
      };
      try {
        const result = await host.run({ sessionId, executionId: input.executionId, resume: input.sessionRef !== null,
          message: input.message, history: input.history, tools, signal: input.signal });
        if (result.sessionId !== sessionId || !Number.isSafeInteger(result.lastEventSeq) || result.lastEventSeq < -1
          || (['completed', 'waiting_input'].includes(result.outcome) && result.lastEventSeq < 0)
          || (checkpoint && result.lastEventSeq < Number(checkpoint.lastEventKey.split(':').at(-1)))
          || !counter(result.modelCalls) || !counter(result.inputTokens) || !counter(result.outputTokens)
          || !Number.isSafeInteger(result.toolCalls) || result.toolCalls < 0
          || !['completed', 'waiting_input', 'cancelled', 'failed', 'outcome_unknown'].includes(result.outcome)
          || typeof result.replayed !== 'boolean' || (result.replayed && toolCalls > 0)) {
          await reportUnknownUsage();
          return failure('DSH_RESULT_INVALID', 'AI 运行结果无法核验');
        }
        const eventKey = `${sessionId}:event:${result.lastEventSeq}`;
        const cost = { modelCalls: result.modelCalls, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          toolCalls: result.toolCalls, synthetic: true,
          usageStatus: result.modelCalls === null || result.inputTokens === null || result.outputTokens === null
            ? 'unknown' as const : 'reported' as const };
        usageAttempted = true;
        await options.onUsage({ teacherId: input.teacherId, taskId: input.taskId, executionId: input.executionId,
          sessionId, eventKey, replayed: result.replayed, outcome: result.outcome, cost, currencyAmount: null });
        if (input.signal.aborted || result.outcome === 'cancelled') return failure('DSH_CANCELLED', '教学任务已暂停', true);
        if (denied) return failure('DSH_TOOL_DENIED', '教学查询未获授权');
        if (result.outcome === 'outcome_unknown') return failure('DSH_OUTCOME_UNKNOWN', '上次操作结果待核对，暂不重试');
        if (result.outcome === 'failed') return failure('DSH_RUN_FAILED', 'AI 暂时未完成，可以重试', true);
        if (typeof result.reply !== 'string' || !result.reply.trim()) return failure('DSH_EMPTY_REPLY', 'AI 尚未返回完整结果', true);
        return ok({ reply: result.reply, sessionRef: sessionId,
          status: result.outcome === 'waiting_input' ? 'waiting_input' as const : 'succeeded' as const,
          checkpoint: { schemaVersion: 1 as const, runtimeVersion: 'dsh-v1' as const,
            contextEpoch: input.contextEpoch, lastEventKey: eventKey }, cost });
      } catch {
        if (!usageAttempted) {
          try {
            await reportUnknownUsage();
          } catch { /* A failed accounting sink must not manufacture success. */ }
        }
        // Exception messages can contain a provider response or source material.
        // They must not be persisted or shown to teachers.
        return failure('DSH_HOST_UNAVAILABLE', 'AI 运行连接中断，结果待核对', false);
      }
    },
  };
}
