import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export const CONFIRMABLE_ACTION_NAMES = [
  'scheduling.complete',
  'scheduling.cancel',
  'lessons.updateStatus',
  'students.updateStatus',
  'students.updateProfile',
  'scheduling.reschedule',
  'lessons.updateRecord',
  'payments.update',
  'memos.update',
  'feedback.updateContent',
  'feedback.updateStatus',
  'payments.create',
  'students.records.capture',
] as const;

export type ConfirmableActionName = (typeof CONFIRMABLE_ACTION_NAMES)[number];
export type PendingActionStatus = 'pending' | 'executing' | 'consumed' | 'cancelled' | 'expired';
export type PendingActionTargetType =
  | 'Student'
  | 'Schedule'
  | 'Lesson'
  | 'Payment'
  | 'Memo'
  | 'ParentFeedback';

export interface ActionTokenSigner {
  sign(pendingActionId: string): Result<string, CommonError>;
  verify(actionToken: string): Result<{ pendingActionId: string }, CommonError>;
}

export interface CreateActionTokenSignerOptions {
  secret: string | Buffer;
}

export interface ConversationOwnerPort {
  getOwnedConversation(input: {
    teacherId: string;
    conversationId: string;
  }): Promise<Result<{ id: string; status: string }, CommonError>>;
}

export interface PendingActionData {
  id: string;
  teacherId: string;
  conversationId: string;
  toolCallId: string;
  actionName: ConfirmableActionName;
  targetType: PendingActionTargetType;
  targetId: string;
  parameters: unknown;
  beforeSummary: string | null;
  afterSummary: string;
  status: PendingActionStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingActionWithToken {
  pendingAction: PendingActionData;
  actionToken: string;
}

export interface CreatePendingActionInput {
  teacherId: string;
  conversationId: string;
  toolCallId: string;
  actionName: ConfirmableActionName;
  target: {
    type: PendingActionTargetType;
    id: string;
  };
  parameters: Record<string, unknown>;
  beforeSummary: string | null;
  afterSummary: string;
}

export interface GetPendingActionInput {
  pendingActionId: string;
  teacherId: string;
}

export interface ListConversationPendingActionsInput {
  teacherId: string;
  conversationId: string;
  toolCallIds: string[];
}

export interface ListActivePendingActionsInput {
  teacherId: string;
  activeAt: Date;
}

export interface PendingActionService {
  createPendingAction(input: CreatePendingActionInput): Promise<Result<PendingActionWithToken, CommonError>>;
  getPendingAction(input: GetPendingActionInput): Promise<Result<PendingActionWithToken, CommonError>>;
  listForConversationToolCalls(
    input: ListConversationPendingActionsInput,
  ): Promise<Result<PendingActionWithToken[], CommonError>>;
  listActivePendingActions(
    input: ListActivePendingActionsInput,
  ): Promise<Result<{ items: PendingActionData[]; total: number }, CommonError>>;
}

export interface OwnedPendingActionInput {
  pendingActionId: string;
  teacherId: string;
}

export interface TimedPendingActionInput extends OwnedPendingActionInput {
  databaseNow: Date;
}

export type PendingActionClaimOutcome =
  | { kind: 'claimed'; pendingAction: PendingActionData }
  | { kind: 'expired'; pendingAction: PendingActionData };

export interface PendingActionExecutionStore {
  getDatabaseNow(): Promise<Result<Date, CommonError>>;
  getOwned(input: OwnedPendingActionInput): Promise<Result<PendingActionData, CommonError>>;
  claim(input: TimedPendingActionInput): Promise<Result<PendingActionClaimOutcome, CommonError>>;
  markConsumed(input: TimedPendingActionInput): Promise<Result<PendingActionData, CommonError>>;
  cancel(input: TimedPendingActionInput): Promise<Result<PendingActionData, CommonError>>;
}

export interface CreatePendingActionServiceOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  actionTokenSigner: ActionTokenSigner;
  conversationOwner: ConversationOwnerPort;
  ttlSeconds?: number;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient | Prisma.TransactionClient>;
  /** P8 phase-3 批5：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}
