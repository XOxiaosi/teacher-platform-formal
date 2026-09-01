import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export type AgentExecutionStatus = 'running' | 'succeeded' | 'failed' | 'partial' | 'waiting_confirmation';
export type AgentExecutionStage = 'conversation' | 'model' | 'tool' | 'persistence' | 'confirmation';
export type RetryAction = 'resend-message' | 'retry-model' | 'retry-tool' | 'none';

export interface AgentExecutionData {
  id: string;
  teacherId: string;
  conversationId: string;
  clientRequestId: string;
  requestFingerprint: string;
  userTurnId: string | null;
  status: AgentExecutionStatus;
  stage: AgentExecutionStage;
  reply: string | null;
  error: CommonError | null;
  completedToolCallIds: string[];
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimAgentExecutionInput {
  teacherId: string;
  conversationId: string;
  clientRequestId: string;
  message: string;
}

export interface CompleteAgentExecutionInput {
  teacherId: string;
  executionId: string;
  status: 'succeeded' | 'waiting_confirmation';
  stage: AgentExecutionStage;
  reply: string;
  completedToolCallIds: string[];
}

export interface FailAgentExecutionInput {
  teacherId: string;
  executionId: string;
  status: 'failed' | 'partial';
  stage: AgentExecutionStage;
  error: CommonError;
  retryable: boolean;
  retryAction: RetryAction;
  completedToolCallIds: string[];
}

export interface AgentExecutionService {
  claim(input: ClaimAgentExecutionInput): Promise<Result<{
    kind: 'claimed' | 'existing';
    execution: AgentExecutionData;
  }, CommonError>>;
  complete(input: CompleteAgentExecutionInput): Promise<Result<AgentExecutionData, CommonError>>;
  fail(input: FailAgentExecutionInput): Promise<Result<AgentExecutionData, CommonError>>;
  get(input: { teacherId: string; executionId: string }): Promise<Result<AgentExecutionData, CommonError>>;
  prepareReplay(input: {
    teacherId: string;
    executionId: string;
    clientRequestId: string;
  }): Promise<Result<{ conversationId: string; message: string; clientRequestId: string }, CommonError>>;
}

export interface CreateAgentExecutionServiceOptions {
  prisma: PrismaClient;
  trustedClock?: TrustedClock;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
  /** P8 phase-3 批3：ConversationTurn 跨服务写读加密 cipher（缺省 env 构建）。 */
  cipher?: FieldCipher;
}
