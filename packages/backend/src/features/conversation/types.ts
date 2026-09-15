import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export type ConversationStatus = 'active' | 'archived';
export type ConversationTurnRole = 'user' | 'assistant' | 'tool' | 'error';

export interface CreateConversationServiceOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient | Prisma.TransactionClient>;
  /** P8 phase-3 批3：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

export interface CreateConversationInput {
  teacherId: string;
}

export interface GetConversationInput {
  conversationId: string;
  teacherId: string;
}

export interface AppendTurnInput {
  conversationId: string;
  teacherId: string;
  role: ConversationTurnRole;
  content: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  audioFileRef?: string | null;
}

export interface ListTurnsInput {
  conversationId: string;
  teacherId: string;
  limit?: number;
}

export interface ListConversationTurnsPageInput {
  conversationId: string;
  teacherId: string;
  before?: string;
  limit?: number;
}

export interface ListConversationsInput {
  teacherId: string;
  status?: ConversationStatus;
  cursor?: string;
  limit?: number;
}

export interface BuildContextInput {
  conversationId: string;
  teacherId: string;
  maxTurns?: number;
}

export interface ArchiveConversationInput {
  conversationId: string;
  teacherId: string;
}

export interface UpdateConversationSummaryInput {
  conversationId: string;
  teacherId: string;
  summary: string;
}

export interface ConversationData {
  id: string;
  teacherId: string;
  status: ConversationStatus;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationTurnData {
  id: string;
  conversationId: string;
  teacherId: string;
  role: ConversationTurnRole;
  content: string;
  toolCalls: unknown | null;
  toolResults: unknown | null;
  audioFileRef: string | null;
  /** A01 runtime association; legacy conversation turns remain null. */
  taskId?: string | null;
  executionId?: string | null;
  seq?: number | null;
  eventKind?: string | null;
  createdAt: Date;
}

export interface ConversationProjectionData extends ConversationData {
  firstUserContent: string | null;
  lastTurnContent: string | null;
  lastTurnAt: Date | null;
  turnCount: number;
}

export interface ConversationListPageData {
  items: ConversationProjectionData[];
  nextCursor: string | null;
}

export interface ConversationTurnsPageData {
  items: ConversationTurnData[];
  previousCursor: string | null;
}

export interface ConversationContextMessage {
  role: ConversationTurnRole | 'system';
  content: string;
  toolCalls?: unknown;
  toolCallId?: string;
}

export interface ConversationService {
  createConversation(input: CreateConversationInput): Promise<Result<ConversationData, CommonError>>;
  getConversation(input: GetConversationInput): Promise<Result<ConversationData, CommonError>>;
  getConversationProjection(input: GetConversationInput): Promise<Result<ConversationProjectionData, CommonError>>;
  listConversations(input: ListConversationsInput): Promise<Result<ConversationListPageData, CommonError>>;
  appendTurn(input: AppendTurnInput): Promise<Result<ConversationTurnData, CommonError>>;
  listTurns(input: ListTurnsInput): Promise<Result<ConversationTurnData[], CommonError>>;
  listConversationTurnsPage(input: ListConversationTurnsPageInput): Promise<Result<ConversationTurnsPageData, CommonError>>;
  buildContext(input: BuildContextInput): Promise<Result<ConversationContextMessage[], CommonError>>;
  archiveConversation(input: ArchiveConversationInput): Promise<Result<ConversationData, CommonError>>;
  updateSummary(input: UpdateConversationSummaryInput): Promise<Result<ConversationData, CommonError>>;
}
