import type { PresentationDocument } from '@teacher-platform/contracts';
import { apiRequest } from './client';
import type { CommonError } from './types';

export type ConversationStatus = 'active' | 'archived';
export type AgentTurnKind = 'user' | 'assistant' | 'tool' | 'error' | 'confirmation';
export type ObjectType = 'Student' | 'Schedule' | 'Lesson' | 'Payment' | 'Memo' | 'ParentFeedback';

export interface ConversationSummaryDto {
  id: string;
  status: ConversationStatus;
  displayTitle: string;
  summary: string | null;
  lastMessagePreview: string | null;
  lastTurnAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  turnCount: number;
}

export interface ObjectReferenceDto {
  type: ObjectType;
  id: string;
  label: string;
  route: string;
}

interface BaseTurnDto {
  id: string;
  conversationId: string;
  /** Present for turns emitted by the persisted teaching-task runtime. */
  taskId?: string | null;
  kind: AgentTurnKind;
  createdAt: string;
}

export interface UserTurnDto extends BaseTurnDto {
  kind: 'user';
  content: string;
  inputSource: 'text' | 'audio';
}

export interface AssistantTurnDto extends BaseTurnDto {
  kind: 'assistant';
  content: string;
  presentation?: PresentationDocument;
  references: ObjectReferenceDto[];
}

export interface ToolTurnDto extends BaseTurnDto {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  displayName: string;
  sideEffect: 'read' | 'create' | 'update' | 'destructive';
  status: 'waiting' | 'running' | 'success' | 'failed' | 'partial' | 'cancelled';
  inputSummary: Record<string, string | number | boolean | null>;
  resultSummary: string | null;
  references: ObjectReferenceDto[];
  error: CommonError | null;
}

export interface ErrorTurnDto extends BaseTurnDto {
  kind: 'error';
  executionId: string;
  stage: 'conversation' | 'model' | 'tool' | 'persistence';
  error: CommonError;
  retryable: boolean;
  retryAction: 'resend-message' | 'retry-model' | 'retry-tool' | 'none';
  completedToolCallIds: string[];
}

export type ConfirmationStatus = 'pending' | 'running' | 'consumed' | 'cancelled' | 'expired';

export interface ConfirmationTargetDto {
  type: 'Student' | 'Schedule' | 'Lesson' | 'Memo';
  id: string;
}

export interface ConfirmationTurnDto extends BaseTurnDto {
  kind: 'confirmation';
  actionId: string;
  actionName: string;
  target: ConfirmationTargetDto;
  beforeSummary: string | null;
  afterSummary: string;
  parameterSummary: Record<string, string | number | boolean | null>;
  status: ConfirmationStatus;
  expiresAt: string;
  actionToken: string | null;
  error: CommonError | null;
}

export interface PendingActionDto {
  id: string;
  conversationId: string;
  actionName: string;
  target: ConfirmationTargetDto;
  beforeSummary: string | null;
  afterSummary: string;
  parameterSummary: Record<string, string | number | boolean | null>;
  status: ConfirmationStatus;
  expiresAt: string;
  actionToken: string | null;
  createdAt: string;
  updatedAt: string;
  error: CommonError | null;
}

export interface PendingActionResponse {
  pendingAction: PendingActionDto;
}

export interface ConfirmPendingActionResponse extends PendingActionResponse {
  result: {
    summary: string;
    references: ConfirmationTargetDto[];
  };
}

export type AgentTurnDto =
  | UserTurnDto
  | AssistantTurnDto
  | ToolTurnDto
  | ErrorTurnDto
  | ConfirmationTurnDto;

export interface ConversationListResponse {
  items: ConversationSummaryDto[];
  nextCursor: string | null;
}

export interface ConversationTurnsResponse {
  items: AgentTurnDto[];
  previousCursor: string | null;
}

export interface ConversationResponse {
  conversation: ConversationDetailDto;
}

export interface ListConversationsParams {
  status?: ConversationStatus;
  cursor?: string;
  limit?: number;
}

export interface ListConversationTurnsParams {
  before?: string;
  limit?: number;
}

function pathWithQuery(path: string, entries: Array<[string, string | number | undefined]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}`;
}

function pendingActionPath(actionId: string): string {
  return `/pending-actions/${encodeURIComponent(actionId)}`;
}

export function createConversation(teacherId: string): Promise<ConversationResponse> {
  return apiRequest('/conversations', { method: 'POST', teacherId });
}

export function listConversations(
  teacherId: string,
  params: ListConversationsParams = {},
): Promise<ConversationListResponse> {
  const path = pathWithQuery('/conversations', [
    ['status', params.status],
    ['cursor', params.cursor],
    ['limit', params.limit],
  ]);
  return apiRequest(path, { method: 'GET', teacherId });
}

export function getConversation(teacherId: string, conversationId: string): Promise<ConversationResponse> {
  return apiRequest(conversationPath(conversationId), { method: 'GET', teacherId });
}

export function listConversationTurns(
  teacherId: string,
  conversationId: string,
  params: ListConversationTurnsParams = {},
): Promise<ConversationTurnsResponse> {
  const path = pathWithQuery(`${conversationPath(conversationId)}/turns`, [
    ['before', params.before],
    ['limit', params.limit],
  ]);
  return apiRequest(path, { method: 'GET', teacherId });
}

export function archiveConversation(teacherId: string, conversationId: string): Promise<ConversationResponse> {
  return apiRequest(`${conversationPath(conversationId)}/archive`, { method: 'POST', teacherId });
}

export function getPendingAction(teacherId: string, actionId: string): Promise<PendingActionResponse> {
  return apiRequest(pendingActionPath(actionId), { method: 'GET', teacherId });
}

export function confirmPendingAction(
  teacherId: string,
  actionId: string,
  actionToken: string,
): Promise<ConfirmPendingActionResponse> {
  return apiRequest(`${pendingActionPath(actionId)}/confirm`, {
    method: 'POST',
    teacherId,
    body: { actionToken },
  });
}

export function cancelPendingAction(teacherId: string, actionId: string): Promise<PendingActionResponse> {
  return apiRequest(`${pendingActionPath(actionId)}/cancel`, { method: 'POST', teacherId });
}
