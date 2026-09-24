import { describe, expect, it, vi } from 'vitest';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createWechatTeachingTaskAgent } from '../../../src/app/teaching-runtime/wechat-teaching-task-agent.js';

const task = (status: string = 'queued') => ({
  id: 'task-1', conversationId: 'conversation-1', currentExecutionId: 'execution-1',
  title: null, status, version: 1, createdAt: '', updatedAt: '', lastError: null,
  canResume: false, runtimeAvailability: 'test_only' as const,
});

const receipt = { executionId: 'execution-1', userTurnId: 'turn-1', clientRequestId: 'wechat:message-1', receivedAt: '' };

function harness(input: {
  status?: string;
  events?: Array<{ executionId: string; content: string }>;
  driven?: { ran: boolean; pending: boolean; status?: string; executionId?: string | null };
} = {}) {
  const events = input.events ?? [];
  const receiveMessage = vi.fn(async () => ok({
    task: task(input.status), receipt, replayed: false,
  }));
  const listTaskEvents = vi.fn(async () => ok({
    items: events.map((event, index) => ({
      seq: index + 1, eventKey: `event-${index}`, eventKind: 'assistant_message' as const,
      executionId: event.executionId, role: 'assistant' as const, content: event.content, createdAt: '',
    })), nextSeq: null,
  }));
  const getTask = vi.fn(async () => ok({ task: task(input.status ?? 'queued'), executions: [], steps: [] }));
  const wake = vi.fn(() => ok({ queued: true }));
  const runOnce = vi.fn(async () => ok(input.driven ?? { ran: true, pending: false, status: 'succeeded', executionId: 'execution-1' }));
  return { tasks: { receiveMessage, getTask, listTaskEvents }, runtimeWorker: { wake, runOnce } };
}

describe('wechat teaching-task agent adapter', () => {
  it('drives the worker and returns only the matching execution reply', async () => {
    const h = harness({ events: [{ executionId: 'other-execution', content: '不要串台' }] });
    h.runtimeWorker.runOnce.mockImplementationOnce(async () => {
      h.tasks.listTaskEvents.mockResolvedValueOnce(ok({
        items: [{ seq: 1, eventKey: 'other', eventKind: 'assistant_message', executionId: 'other-execution', role: 'assistant', content: '不要串台', createdAt: '' },
          { seq: 2, eventKey: 'ours', eventKind: 'assistant_message', executionId: 'execution-1', role: 'assistant', content: '已处理', createdAt: '' }], nextSeq: null,
      }));
      return ok({ ran: true, pending: false, status: 'succeeded', executionId: 'execution-1' });
    });
    const result = await createWechatTeachingTaskAgent(h).execute({
      teacherId: 'teacher-1', conversationId: 'conversation-1', message: '请处理', clientRequestId: 'wechat:message-1',
    });
    expect(result).toEqual(ok({ reply: '已处理' }));
    expect(h.runtimeWorker.wake).toHaveBeenCalledWith({ teacherId: 'teacher-1', taskId: 'task-1' });
    expect(h.runtimeWorker.runOnce).toHaveBeenCalledTimes(1);
  });

  it('returns a durable replay reply without waking the worker', async () => {
    const h = harness({ status: 'succeeded', events: [{ executionId: 'execution-1', content: '已重放' }] });
    const result = await createWechatTeachingTaskAgent(h).execute({
      teacherId: 'teacher-1', conversationId: 'conversation-1', message: '重放', clientRequestId: 'wechat:message-1',
    });
    expect(result).toEqual(ok({ reply: '已重放' }));
    expect(h.runtimeWorker.wake).not.toHaveBeenCalled();
    expect(h.runtimeWorker.runOnce).not.toHaveBeenCalled();
  });

  it('handles waiting input and unavailable states truthfully', async () => {
    const waiting = harness({ status: 'waiting_input', events: [{ executionId: 'execution-1', content: '请补充年级' }] });
    await expect(createWechatTeachingTaskAgent(waiting).execute({ teacherId: 't', conversationId: 'c', message: 'm', clientRequestId: 'wechat:1' }))
      .resolves.toEqual(ok({ reply: '请补充年级' }));
    const unavailable = harness({ status: 'unavailable' });
    await expect(createWechatTeachingTaskAgent(unavailable).execute({ teacherId: 't', conversationId: 'c', message: 'm', clientRequestId: 'wechat:1' }))
      .resolves.toEqual(err(internalError('教学任务运行能力当前不可用')));
  });

  it('does not treat a terminal task without its execution reply as success', async () => {
    const succeeded = harness({ status: 'succeeded' });
    await expect(createWechatTeachingTaskAgent(succeeded).execute({
      teacherId: 't', conversationId: 'c', message: 'm', clientRequestId: 'wechat:1',
    })).resolves.toEqual(err(internalError('教学任务已结束但没有可发送的助手回复')));
    expect(succeeded.runtimeWorker.runOnce).not.toHaveBeenCalled();
  });

  it('fails closed when a queued task has no runtime worker', async () => {
    const h = harness();
    await expect(createWechatTeachingTaskAgent({ tasks: h.tasks }).execute({
      teacherId: 't', conversationId: 'c', message: 'm', clientRequestId: 'wechat:1',
    })).resolves.toEqual(err(internalError('教学任务运行器当前不可用')));
  });

  it('propagates receive and runtime failures instead of fabricating a reply', async () => {
    const h = harness();
    const failure = internalError('运行失败');
    h.tasks.receiveMessage.mockResolvedValueOnce(err(failure));
    await expect(createWechatTeachingTaskAgent(h).execute({ teacherId: 't', conversationId: 'c', message: 'm', clientRequestId: 'wechat:1' }))
      .resolves.toEqual(err(failure));
    const h2 = harness();
    h2.runtimeWorker.runOnce.mockResolvedValueOnce(err(failure));
    await expect(createWechatTeachingTaskAgent(h2).execute({ teacherId: 't', conversationId: 'c', message: 'm', clientRequestId: 'wechat:1' }))
      .resolves.toEqual(err(failure));
  });
});
