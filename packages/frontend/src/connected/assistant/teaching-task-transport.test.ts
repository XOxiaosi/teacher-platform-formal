import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeachingTaskTransport } from './teaching-task-transport';
import type { TeachingTaskDto } from '../../api/teaching-tasks';

const api = vi.hoisted(() => ({
  create: vi.fn(), send: vi.fn(), list: vi.fn(), get: vi.fn(), resume: vi.fn(),
  events: vi.fn(),
}));
vi.mock('../../api/teaching-tasks', () => ({
  createTeachingConversation: api.create,
  sendTeachingTaskMessage: api.send,
  listTeachingTasks: api.list,
  getTeachingTask: api.get,
  resumeTeachingTask: api.resume,
  listTeachingTaskEvents: api.events,
}));

const task = (overrides: Partial<TeachingTaskDto> = {}): TeachingTaskDto => ({
  id: 'task-1', conversationId: 'conversation-1', currentExecutionId: 'execution-1',
  title: null, status: 'unavailable', version: 2,
  createdAt: '2026-09-15T12:00:00Z', updatedAt: '2026-09-15T12:00:00Z',
  lastError: { code: 'RUNTIME_UNAVAILABLE', message: 'AI 服务尚未连接', retryable: true },
  canResume: false, runtimeAvailability: 'unavailable', ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe('formal teaching task transport', () => {
  it('uses the durable teaching task API and keeps unavailable explicit', async () => {
    api.create.mockResolvedValue({ id: 'conversation-1', createdAt: '2026-09-15T12:00:00Z' });
    api.send.mockResolvedValue({ task: task(), receipt: { executionId: 'execution-1', userTurnId: 'turn-1', clientRequestId: 'request-1', receivedAt: '2026-09-15T12:00:00Z' }, replayed: false });
    const transport = createTeachingTaskTransport();
    expect(transport.runtimeAvailability).toBe('unavailable');
    await expect(transport.createConversation?.({ teacherId: 'teacher-a' })).resolves.toBe('conversation-1');
    await expect(transport.sendMessage({ teacherId: 'teacher-a', conversationId: 'conversation-1', message: '核对课时', clientRequestId: 'request-1' })).resolves.toMatchObject({ accepted: true, task: { id: 'task-1', status: 'unavailable', summary: 'AI 服务尚未连接' } });
    expect(api.send).toHaveBeenCalledWith('teacher-a', { conversationId: 'conversation-1', message: '核对课时', clientRequestId: 'request-1' });
  });

  it('resumes with the server version and execution id after reloading the task', async () => {
    api.get.mockResolvedValue({ task: task({ status: 'partial', canResume: true, lastError: null }) });
    api.resume.mockResolvedValue({ task: task({ status: 'running', canResume: false }), replayed: false });
    const transport = createTeachingTaskTransport();
    await expect(transport.resumeTask?.({ teacherId: 'teacher-a', conversationId: 'conversation-1', taskId: 'task-1' })).resolves.toMatchObject({ id: 'task-1', status: 'running' });
    expect(api.resume).toHaveBeenCalledWith('teacher-a', expect.objectContaining({ id: 'task-1', currentExecutionId: 'execution-1', version: 2 }));
  });

  it('reads task events with the server cursor', async () => {
    api.events.mockResolvedValue({ items: [{ seq: 3, eventKey: 'event-3', eventKind: 'task_state', executionId: 'execution-1', role: 'assistant', content: '已保存任务状态', createdAt: '2026-09-15T12:00:00Z' }], nextSeq: 3 });
    const transport = createTeachingTaskTransport();
    await expect(transport.getTaskEvents?.({ teacherId: 'teacher-a', conversationId: 'conversation-1', taskId: 'task-1', afterSeq: 2 })).resolves.toMatchObject({ nextSeq: 3 });
    expect(api.events).toHaveBeenCalledWith('teacher-a', 'task-1', 2);
  });

  it('loads every task page so the recovery view can read task 21 and its events', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => task({ id: `task-${index + 1}`, title: `任务${index + 1}` }));
    api.list.mockImplementation((_teacher: string, _conversation: string, params: { cursor?: string }) => Promise.resolve(params.cursor
      ? { items: [task({ id: 'task-21', title: '任务21' })], nextCursor: null }
      : { items: firstPage, nextCursor: 'page-2' }));
    const transport = createTeachingTaskTransport();
    const tasks = await transport.getTasks?.({ teacherId: 'teacher-a', conversationId: 'conversation-1' });
    expect(tasks).toHaveLength(21);
    expect(tasks?.at(-1)).toMatchObject({ id: 'task-21', summary: '任务21' });
    expect(api.list).toHaveBeenNthCalledWith(2, 'teacher-a', 'conversation-1', { cursor: 'page-2' });
    api.events.mockResolvedValue({ items: [{ seq: 1, eventKey: 'task-21-event-1', eventKind: 'task_state', executionId: 'execution-1', role: 'assistant', content: '任务21已恢复', createdAt: '2026-09-15T12:00:00Z' }], nextSeq: 1 });
    await transport.getTaskEvents?.({ teacherId: 'teacher-a', conversationId: 'conversation-1', taskId: 'task-21' });
    expect(api.events).toHaveBeenCalledWith('teacher-a', 'task-21', undefined);
  });

  it('stops task pagination when the server repeats a cursor', async () => {
    const page = [task({ id: 'task-1', title: '任务1' })];
    api.list.mockResolvedValue({ items: page, nextCursor: 'same-page' });
    const transport = createTeachingTaskTransport();
    const tasks = await transport.getTasks?.({ teacherId: 'teacher-a', conversationId: 'conversation-1' });
    expect(tasks).toHaveLength(2);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith('teacher-a', 'conversation-1', { cursor: 'same-page' });
  });

  it('loads all event pages and de-duplicates an event repeated at the page boundary', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      seq: index + 1, eventKey: `event-${index + 1}`, eventKind: 'task_state' as const,
      executionId: 'execution-1', role: 'assistant' as const, content: `进展${index + 1}`, createdAt: '2026-09-15T12:00:00Z',
    }));
    const repeated = firstPage.at(-1)!;
    const secondPage = [repeated, { ...repeated, seq: 51, eventKey: 'event-51', content: '进展51' }, { ...repeated, seq: 52, eventKey: 'event-52', content: '进展52' }];
    api.events.mockImplementation((_teacher: string, _taskId: string, afterSeq?: number) => Promise.resolve(afterSeq === 50
      ? { items: secondPage, nextSeq: null }
      : { items: firstPage, nextSeq: 50 }));
    const transport = createTeachingTaskTransport();
    const result = await transport.getTaskEvents?.({ teacherId: 'teacher-a', conversationId: 'conversation-1', taskId: 'task-1' });
    expect(result?.items).toHaveLength(52);
    expect(result?.items.map(event => event.eventKey)).toEqual(expect.arrayContaining(['event-1', 'event-50', 'event-51', 'event-52']));
    expect(api.events).toHaveBeenNthCalledWith(2, 'teacher-a', 'task-1', 50);
  });
});
