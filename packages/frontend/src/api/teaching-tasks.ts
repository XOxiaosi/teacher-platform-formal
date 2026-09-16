import { apiRequest } from './client';

export type TeachingTaskStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_confirmation'
  | 'succeeded' | 'failed' | 'partial' | 'unavailable' | 'cancelled';
export type TeachingRuntimeAvailability = 'available' | 'unavailable' | 'test_only';

export interface TeachingTaskDto {
  id: string;
  conversationId: string;
  currentExecutionId: string | null;
  title: string | null;
  status: TeachingTaskStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastError: { code: string; message: string; retryable: boolean } | null;
  canResume: boolean;
  runtimeAvailability: TeachingRuntimeAvailability;
}

export interface TeachingTaskReceipt {
  executionId: string;
  userTurnId: string;
  clientRequestId: string;
  receivedAt: string;
}

export type TeachingTaskEventKind = 'message_received' | 'task_state' | 'step_result' | 'task_error' | 'assistant_message';
export interface TeachingTaskEventDto {
  seq: number;
  eventKey: string;
  eventKind: TeachingTaskEventKind;
  executionId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  createdAt: string;
}

export function getTeachingRuntimeAvailability(
  teacherId: string,
): Promise<{ runtimeAvailability: TeachingRuntimeAvailability }> {
  return apiRequest('/teaching-runtime', { method: 'GET', teacherId });
}

export function createTeachingConversation(teacherId: string): Promise<{ id: string; createdAt: string }> {
  return apiRequest('/teaching-conversations', { method: 'POST', teacherId });
}

export function sendTeachingTaskMessage(
  teacherId: string,
  input: { conversationId: string; clientRequestId: string; message: string },
): Promise<{ task: TeachingTaskDto; receipt: TeachingTaskReceipt; replayed: boolean }> {
  return apiRequest('/teaching-tasks', { method: 'POST', teacherId, body: input });
}

export function listTeachingTasks(
  teacherId: string,
  conversationId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<{ items: TeachingTaskDto[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ conversationId });
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  return apiRequest(`/teaching-tasks?${query.toString()}`, { method: 'GET', teacherId });
}

export function getTeachingTask(teacherId: string, taskId: string): Promise<{ task: TeachingTaskDto }> {
  return apiRequest(`/teaching-tasks/${encodeURIComponent(taskId)}`, { method: 'GET', teacherId });
}

export function listTeachingTaskEvents(
  teacherId: string,
  taskId: string,
  afterSeq?: number,
): Promise<{ items: TeachingTaskEventDto[]; nextSeq: number | null }> {
  const query = new URLSearchParams();
  if (afterSeq !== undefined) query.set('afterSeq', String(afterSeq));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest(`/teaching-tasks/${encodeURIComponent(taskId)}/events${suffix}`, { method: 'GET', teacherId });
}

export function resumeTeachingTask(
  teacherId: string,
  task: Pick<TeachingTaskDto, 'id' | 'currentExecutionId' | 'version'>,
): Promise<{ task: TeachingTaskDto; replayed: boolean }> {
  if (!task.currentExecutionId) throw new Error('任务缺少可恢复的执行上下文');
  return apiRequest(`/teaching-tasks/${encodeURIComponent(task.id)}/resume`, {
    method: 'POST',
    teacherId,
    body: { executionId: task.currentExecutionId, expectedVersion: task.version },
  });
}
