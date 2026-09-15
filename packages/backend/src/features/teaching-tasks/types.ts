import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export type TaskStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_confirmation'
  | 'succeeded' | 'failed' | 'partial' | 'unavailable' | 'cancelled';
export type RuntimeAvailability = 'available' | 'unavailable' | 'test_only';
export type StepStatus = 'prepared' | 'running' | 'waiting_confirmation' | 'succeeded'
  | 'failed' | 'uncertain' | 'invalidated';
export type StepKind = 'query';

export interface TaskError { code: string; message: string; retryable: boolean; }
export interface SourceRef { type: string; id: string; version: string; }
export interface TaskDTO {
  id: string; conversationId: string; currentExecutionId: string | null;
  title: string | null; status: TaskStatus; version: number;
  createdAt: string; updatedAt: string; lastError: TaskError | null;
  canResume: boolean; runtimeAvailability: RuntimeAvailability;
}
export interface MessageReceipt {
  executionId: string; userTurnId: string; clientRequestId: string; receivedAt: string;
}
export interface StepDTO {
  id: string; executionId: string; kind: StepKind; status: StepStatus;
  result: unknown | null; sourceRefs: SourceRef[];
  confirmation: null;
  error: TaskError | null;
}
export interface TaskEventDTO {
  seq: number; eventKey: string; eventKind: 'message_received' | 'task_state' | 'step_result' | 'task_error' | 'assistant_message';
  executionId: string | null; role: 'user' | 'assistant' | 'tool' | 'error'; content: string; createdAt: string;
}
export interface TaskDetailDTO { task: TaskDTO; executions: Array<{ id: string; status: string; clientRequestId: string; createdAt: string }>; steps: StepDTO[]; }

export interface TeachingTaskLease { taskId: string; teacherId: string; leaseToken: string; leaseEpoch: number; }
export interface CreateTeachingTaskServiceOptions {
  prisma: PrismaClient;
  getClient?: () => Promise<PrismaClient>;
  cipher?: FieldCipher;
  /** Internal integration/test switch. It is never derived from an HTTP request. */
  runtimeAvailability?: RuntimeAvailability;
  leaseMs?: number;
}

export interface TeachingTaskService {
  createConversation(input: { teacherId: string }): Promise<Result<{ id: string; createdAt: string }, CommonError>>;
  receiveMessage(input: {
    teacherId: string; conversationId: string; taskId?: string; clientRequestId: string; message: string;
    expectedVersion?: number; materialRefs?: SourceRef[];
  }): Promise<Result<{ task: TaskDTO; receipt: MessageReceipt; replayed: boolean }, CommonError>>;
  getTask(input: { teacherId: string; taskId: string }): Promise<Result<TaskDetailDTO, CommonError>>;
  listTasks(input: { teacherId: string; conversationId?: string; cursor?: string; limit?: number }): Promise<Result<{ items: TaskDTO[]; nextCursor: string | null }, CommonError>>;
  listTaskEvents(input: { teacherId: string; taskId: string; afterSeq?: number; limit?: number }): Promise<Result<{ items: TaskEventDTO[]; nextSeq: number | null }, CommonError>>;
  resume(input: { teacherId: string; taskId: string; executionId: string; expectedVersion: number }): Promise<Result<{ task: TaskDTO; replayed: boolean }, CommonError>>;
  claim(input: { teacherId: string; taskId: string }): Promise<Result<{ task: TaskDTO; lease: TeachingTaskLease } | { task: TaskDTO; unavailable: true }, CommonError>>;
  heartbeat(input: TeachingTaskLease): Promise<Result<TaskDTO, CommonError>>;
  prepareStep(input: TeachingTaskLease & { executionId: string; stepKey: string; inputFingerprint: string; kind: StepKind; sourceRefs?: SourceRef[] }): Promise<Result<StepDTO, CommonError>>;
  completeStep(input: TeachingTaskLease & { executionId: string; stepKey: string; result: unknown | null }): Promise<Result<StepDTO, CommonError>>;
  failStep(input: TeachingTaskLease & { executionId: string; stepKey: string; error: TaskError; status?: 'failed' | 'uncertain' }): Promise<Result<StepDTO, CommonError>>;
  finish(input: TeachingTaskLease & { executionId: string; status: 'succeeded' | 'partial' | 'failed' | 'waiting_input'; error?: TaskError; reply?: string }): Promise<Result<TaskDTO, CommonError>>;
}
