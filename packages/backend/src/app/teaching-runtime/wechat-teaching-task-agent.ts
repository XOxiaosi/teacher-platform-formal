import { createHash } from 'node:crypto';
import { err, internalError, ok, type CommonError, type Result } from '@teacher-platform/contracts';
import type { TeachingTaskService, TaskEventDTO } from '../../features/teaching-tasks/types.js';
import type { TeachingTaskRuntimeWorker } from './teaching-task-runtime-worker.js';

export interface WechatTeachingTaskAgentPort {
  execute(input: {
    teacherId: string;
    conversationId: string;
    message: string;
    clientRequestId?: string;
  }): Promise<Result<{ reply: string | null }, CommonError>>;
}

export interface CreateWechatTeachingTaskAgentOptions {
  tasks: Pick<TeachingTaskService, 'receiveMessage' | 'getTask' | 'listTaskEvents'>;
  runtimeWorker?: Pick<TeachingTaskRuntimeWorker, 'wake' | 'runOnce'>;
  /** Bounds a channel worker if a driver leaves work queued without progress. */
  maxRuns?: number;
}

function fallbackRequestId(conversationId: string, message: string): string {
  const digest = createHash('sha256').update(`${conversationId}\n${message}`).digest('hex').slice(0, 40);
  return `wechat:${digest}`;
}

async function assistantReply(
  tasks: Pick<TeachingTaskService, 'listTaskEvents'>,
  teacherId: string,
  taskId: string,
  executionId: string,
): Promise<Result<string | null, CommonError>> {
  let afterSeq = 0;
  for (;;) {
    const page = await tasks.listTaskEvents({ teacherId, taskId, afterSeq, limit: 100 });
    if (!page.ok) return page;
    const match = page.value.items.find((event: TaskEventDTO) =>
      event.eventKind === 'assistant_message' && event.executionId === executionId,
    );
    if (match) return ok(match.content);
    if (page.value.nextSeq === null) return ok(null);
    afterSeq = page.value.nextSeq;
  }
}

export function createWechatTeachingTaskAgent(
  options: CreateWechatTeachingTaskAgentOptions,
): WechatTeachingTaskAgentPort {
  const maxRuns = options.maxRuns ?? 8;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) {
    throw new Error('maxRuns 必须是 1 到 100 的整数');
  }

  return {
    async execute(input) {
      const clientRequestId = input.clientRequestId ?? fallbackRequestId(input.conversationId, input.message);
      const received = await options.tasks.receiveMessage({
        teacherId: input.teacherId,
        conversationId: input.conversationId,
        clientRequestId,
        message: input.message,
      });
      if (!received.ok) return received;
      const { task, receipt } = received.value;

      // A replay may already have a durable assistant event. Read it before
      // waking the worker, so a channel retry never runs another execution.
      const existing = await assistantReply(options.tasks, input.teacherId, task.id, receipt.executionId);
      if (!existing.ok) return existing;
      if (existing.value !== null) return ok({ reply: existing.value });
      if (task.status === 'unavailable') return err(internalError('教学任务运行能力当前不可用'));
      if (task.status === 'failed') return err(internalError('教学任务执行失败且没有助手回复'));
      if (!['queued', 'running'].includes(task.status)) {
        return err(internalError('教学任务已结束但没有可发送的助手回复'));
      }
      if (!options.runtimeWorker) return err(internalError('教学任务运行器当前不可用'));

      const wake = options.runtimeWorker.wake({ teacherId: input.teacherId, taskId: task.id });
      if (!wake.ok) return wake;
      for (let run = 0; run < maxRuns; run += 1) {
        const driven = await options.runtimeWorker.runOnce();
        if (!driven.ok) return driven;
        const result = await assistantReply(options.tasks, input.teacherId, task.id, receipt.executionId);
        if (!result.ok) return result;
        if (result.value !== null) return ok({ reply: result.value });
        const current = await options.tasks.getTask({ teacherId: input.teacherId, taskId: task.id });
        if (!current.ok) return current;
        const status = current.value.task.status;
        if (status === 'unavailable') return err(internalError('教学任务运行能力当前不可用'));
        if (status === 'failed') return err(internalError('教学任务执行失败且没有助手回复'));
        if (!['queued', 'running'].includes(status)) {
          return err(internalError('教学任务已结束但没有可发送的助手回复'));
        }
        // runOnce may have consumed unrelated process-local work first. Keep
        // the target wake durable in the dispatcher while it is still queued.
        const rewake = options.runtimeWorker.wake({ teacherId: input.teacherId, taskId: task.id });
        if (!rewake.ok) return rewake;
      }
      return err(internalError('教学任务运行未在限定次数内完成'));
    },
  };
}
