import type { CommonError, PresentationDocument } from '@teacher-platform/contracts';
import type {
  ConversationProjectionData,
  ConversationTurnData,
} from '../../features/conversation/index.js';
import type { PendingActionWithToken } from '../../features/pending-action/index.js';
import { getToolPresentation, type ToolSideEffect } from './tool-presentation.js';
import {
  toConfirmationTurnDto,
  type ConfirmationTurnDto,
} from './pending-action-response.js';
import {
  buildFallbackPresentation,
  readAssistantPresentationEnvelope,
} from '../presentation/index.js';

const TITLE_MAX_LENGTH = 40;
const PREVIEW_MAX_LENGTH = 80;

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

export interface ConversationSummaryDto {
  id: string;
  status: 'active' | 'archived';
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

interface BaseTurnDto {
  id: string;
  conversationId: string;
  taskId: string | null;
  executionId: string | null;
  seq: number | null;
  eventKind: string | null;
  createdAt: string;
}

interface UserTurnDto extends BaseTurnDto {
  kind: 'user';
  content: string;
  inputSource: 'text' | 'audio';
}

interface AssistantTurnDto extends BaseTurnDto {
  kind: 'assistant';
  content: string;
  presentation?: PresentationDocument;
  references: never[];
}

interface ErrorTurnDto extends BaseTurnDto {
  kind: 'error';
  executionId: string | null;
  stage: 'conversation' | 'model' | 'tool' | 'persistence';
  error: CommonError;
  retryable: boolean;
  retryAction: 'resend-message' | 'retry-model' | 'retry-tool' | 'none';
  completedToolCallIds: string[];
}

interface ToolTurnDto extends BaseTurnDto {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  displayName: string;
  sideEffect: ToolSideEffect;
  status: 'success' | 'failed';
  inputSummary: Record<string, string | number | boolean | null>;
  resultSummary: string | null;
  references: Array<{ type: 'Student'; id: string; label: string; route: string }>;
  error: CommonError | null;
}

export type AgentTurnDto = UserTurnDto | AssistantTurnDto | ToolTurnDto | ErrorTurnDto | ConfirmationTurnDto;

interface PersistedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolCalls(value: unknown): PersistedToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PersistedToolCall => (
    isRecord(item)
    && typeof item.id === 'string'
    && typeof item.name === 'string'
    && isRecord(item.args)
  ));
}

function toolCallIdOf(value: unknown): string {
  return isRecord(value) && typeof value.toolCallId === 'string' ? value.toolCallId : '';
}

export function extractToolCallIds(turns: ConversationTurnData[]): string[] {
  const ids = turns
    .filter((turn) => turn.role === 'tool')
    .map((turn) => toolCallIdOf(turn.toolResults))
    .filter((id) => id !== '');
  return [...new Set(ids)];
}

function summarizeArgs(args: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [key, value];
    }
    return [key, JSON.stringify(value)];
  }));
}

function toErrorTurnDto(turn: ConversationTurnData): ErrorTurnDto {
  const data = isRecord(turn.toolResults) ? turn.toolResults : {};
  const error = isRecord(data.error) ? data.error : {};
  const completed = Array.isArray(data.completedToolCallIds)
    ? data.completedToolCallIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    taskId: turn.taskId ?? null,
    executionId: turn.executionId ?? (typeof data.executionId === 'string' ? data.executionId : null),
    seq: turn.seq ?? null,
    eventKind: turn.eventKind ?? null,
    kind: 'error',
    createdAt: turn.createdAt.toISOString(),
    stage: data.stage === 'model' || data.stage === 'tool' || data.stage === 'persistence'
      ? data.stage
      : 'conversation',
    error: {
      code: typeof error.code === 'string' ? error.code as CommonError['code'] : 'INTERNAL_ERROR',
      message: typeof error.message === 'string' ? error.message : turn.content,
      ...(typeof error.field === 'string' ? { field: error.field } : {}),
    },
    retryable: data.retryable === true,
    retryAction: data.retryAction === 'resend-message'
      || data.retryAction === 'retry-model'
      || data.retryAction === 'retry-tool'
      ? data.retryAction
      : 'none',
    completedToolCallIds: completed,
  };
}

function toToolTurnDto(
  turn: ConversationTurnData,
  callsById: Map<string, PersistedToolCall>,
): ToolTurnDto {
  const toolCallId = toolCallIdOf(turn.toolResults);
  const call = callsById.get(toolCallId);
  const data = isRecord(turn.toolResults) ? turn.toolResults : {};
  const savedStudent = data.toolName === 'students.create' && isRecord(data.savedStudent)
    && typeof data.savedStudent.id === 'string' && typeof data.savedStudent.name === 'string' ? data.savedStudent : null;
  const toolName = call?.name ?? (savedStudent ? 'students.create' : 'unknown');
  const presentation = getToolPresentation(toolName);
  const storedError = isRecord(turn.toolResults) && isRecord(turn.toolResults.error)
    ? turn.toolResults.error
    : null;
  const failed = storedError !== null || turn.content.startsWith('Error:');
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    taskId: turn.taskId ?? null,
    executionId: turn.executionId ?? null,
    seq: turn.seq ?? null,
    eventKind: turn.eventKind ?? null,
    kind: 'tool',
    createdAt: turn.createdAt.toISOString(),
    toolCallId,
    toolName,
    displayName: presentation.displayName,
    sideEffect: presentation.sideEffect,
    status: failed ? 'failed' : 'success',
    inputSummary: summarizeArgs(call?.args ?? {}),
    resultSummary: failed ? null : truncate(turn.content, PREVIEW_MAX_LENGTH),
    references: !failed && savedStudent ? [{ type: 'Student', id: savedStudent.id as string,
      label: `查看学生 ${savedStudent.name}`, route: `students/${encodeURIComponent(savedStudent.id as string)}` }] : [],
    error: failed
      ? {
        code: typeof storedError?.code === 'string'
          ? storedError.code as CommonError['code']
          : 'INTERNAL_ERROR',
        message: typeof storedError?.message === 'string'
          ? storedError.message
          : turn.content.slice('Error:'.length).trim() || '工具执行失败',
        ...(typeof storedError?.field === 'string' ? { field: storedError.field } : {}),
      }
      : null,
  };
}

export function toConversationSummaryDto(data: ConversationProjectionData): ConversationSummaryDto {
  return {
    id: data.id,
    status: data.status,
    displayTitle: data.firstUserContent ? truncate(data.firstUserContent, TITLE_MAX_LENGTH) : '新会话',
    summary: data.summary,
    lastMessagePreview: data.lastTurnContent ? truncate(data.lastTurnContent, PREVIEW_MAX_LENGTH) : null,
    lastTurnAt: data.lastTurnAt?.toISOString() ?? null,
    createdAt: data.createdAt.toISOString(),
    updatedAt: data.updatedAt.toISOString(),
  };
}

export function toConversationDetailDto(data: ConversationProjectionData): ConversationDetailDto {
  return { ...toConversationSummaryDto(data), turnCount: data.turnCount };
}

export function toAgentTurnDtos(
  turns: ConversationTurnData[],
  pendingActions: PendingActionWithToken[] = [],
): AgentTurnDto[] {
  const callsById = new Map<string, PersistedToolCall>();
  for (const turn of turns) {
    for (const call of parseToolCalls(turn.toolCalls)) callsById.set(call.id, call);
  }
  const pendingByToolCallId = new Map(
    pendingActions.map((action) => [action.pendingAction.toolCallId, action]),
  );

  return turns.map((turn) => {
    const base = {
      id: turn.id,
      conversationId: turn.conversationId,
      taskId: turn.taskId ?? null,
      executionId: turn.executionId ?? null,
      seq: turn.seq ?? null,
      eventKind: turn.eventKind ?? null,
      content: turn.content,
      createdAt: turn.createdAt.toISOString(),
    };
    if (turn.role === 'user') {
      return { ...base, kind: 'user', inputSource: turn.audioFileRef ? 'audio' : 'text' };
    }
    if (turn.role === 'assistant') {
      if (parseToolCalls(turn.toolCalls).length > 0) {
        return { ...base, kind: 'assistant', references: [] };
      }
      return {
        ...base,
        kind: 'assistant',
        presentation: readAssistantPresentationEnvelope(turn.toolResults)
          ?? buildFallbackPresentation(turn.content),
        references: [],
      };
    }
    if (turn.role === 'error') return toErrorTurnDto(turn);
    const pending = pendingByToolCallId.get(toolCallIdOf(turn.toolResults));
    return pending
      ? { ...toConfirmationTurnDto(pending), ...(turn.eventKind === 'step_result' ? { id: turn.id, createdAt: turn.createdAt.toISOString() } : {}), taskId: turn.taskId ?? null, executionId: turn.executionId ?? null, seq: turn.seq ?? null, eventKind: turn.eventKind ?? null }
      : toToolTurnDto(turn, callsById);
  });
}
