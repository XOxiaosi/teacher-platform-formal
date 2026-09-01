import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  ConfirmableActionName,
  PendingActionData,
  PendingActionStatus,
  PendingActionTargetType,
} from './types.js';

export interface PendingActionRecord {
  id: string;
  teacherId: string;
  conversationId: string;
  toolCallId: string;
  actionName: string;
  targetType: string;
  targetId: string;
  parameters: unknown;
  beforeSummary: string | null;
  afterSummary: string;
  status: string;
  expiresAtTs: Date;
  consumedAtTs: Date | null;
  cancelledAtTs: Date | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

export function toPendingActionData(
  record: PendingActionRecord,
  cipher?: FieldCipher,
): PendingActionData {
  const fieldCipher = cipher ?? createFieldCipherFromEnv();
  return {
    ...record,
    actionName: record.actionName as ConfirmableActionName,
    targetType: record.targetType as PendingActionTargetType,
    status: record.status as PendingActionStatus,
    expiresAt: record.expiresAtTs,
    consumedAt: record.consumedAtTs,
    cancelledAt: record.cancelledAtTs,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
    // P8 phase-3 批5：parameters/beforeSummary/afterSummary 解密（双读：明文旧行直通）
    parameters: decryptJsonFieldValue(fieldCipher, record.parameters),
    beforeSummary: record.beforeSummary === null ? null : decryptFieldValue(fieldCipher, record.beforeSummary),
    afterSummary: decryptFieldValue(fieldCipher, record.afterSummary),
  };
}
