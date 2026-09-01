import type { CommonError } from '@teacher-platform/contracts';
import type {
  PendingActionTargetType,
  PendingActionWithToken,
} from '../../features/pending-action/index.js';

export type PendingActionDtoStatus = 'pending' | 'running' | 'consumed' | 'cancelled' | 'expired';

export interface PendingActionDto {
  id: string;
  conversationId: string;
  actionName: string;
  target: { type: PendingActionTargetType; id: string };
  beforeSummary: string | null;
  afterSummary: string;
  parameterSummary: Record<string, string | number | boolean | null>;
  status: PendingActionDtoStatus;
  expiresAt: string;
  actionToken: string | null;
  createdAt: string;
  updatedAt: string;
  error: CommonError | null;
}

export interface ConfirmationTurnDto {
  id: string;
  conversationId: string;
  kind: 'confirmation';
  createdAt: string;
  actionId: string;
  actionName: string;
  target: PendingActionDto['target'];
  beforeSummary: string | null;
  afterSummary: string;
  parameterSummary: PendingActionDto['parameterSummary'];
  status: PendingActionDtoStatus;
  expiresAt: string;
  actionToken: string | null;
  error: CommonError | null;
}

function parameterSummary(value: unknown): PendingActionDto['parameterSummary'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
    const item = entry[1];
    return item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
  }));
}

function dtoStatus(status: PendingActionWithToken['pendingAction']['status']): PendingActionDtoStatus {
  return status === 'executing' ? 'running' : status;
}

export function toPendingActionDto(data: PendingActionWithToken): PendingActionDto {
  const action = data.pendingAction;
  const status = dtoStatus(action.status);
  return {
    id: action.id,
    conversationId: action.conversationId,
    actionName: action.actionName,
    target: { type: action.targetType, id: action.targetId },
    beforeSummary: action.beforeSummary,
    afterSummary: action.afterSummary,
    parameterSummary: parameterSummary(action.parameters),
    status,
    expiresAt: action.expiresAt.toISOString(),
    actionToken: status === 'pending' ? data.actionToken : null,
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString(),
    error: null,
  };
}

export function toConfirmationTurnDto(data: PendingActionWithToken): ConfirmationTurnDto {
  const dto = toPendingActionDto(data);
  return {
    id: dto.id,
    conversationId: dto.conversationId,
    kind: 'confirmation',
    createdAt: dto.createdAt,
    actionId: dto.id,
    actionName: dto.actionName,
    target: dto.target,
    beforeSummary: dto.beforeSummary,
    afterSummary: dto.afterSummary,
    parameterSummary: dto.parameterSummary,
    status: dto.status,
    expiresAt: dto.expiresAt,
    actionToken: dto.actionToken,
    error: dto.error,
  };
}
