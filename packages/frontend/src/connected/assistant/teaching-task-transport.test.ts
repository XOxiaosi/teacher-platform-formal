import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeachingTaskTransport } from './teaching-task-transport';
import type { TeachingTaskDto } from '../../api/teaching-tasks';

const api = vi.hoisted(() => ({
  create: vi.fn(), send: vi.fn(), list: vi.fn(), get: vi.fn(), resume: vi.fn(),
}));
vi.mock('../../api/teaching-tasks', () => ({
  createTeachingConversation: api.create,
  sendTeachingTaskMessage: api.send,
  listTeachingTasks: api.list,
  getTeachingTask: api.get,
  resumeTeachingTask: api.resume,
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
});
