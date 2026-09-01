import type { Prisma } from '@prisma/client';
import { createConfirmableActionRegistry } from './confirmable-action-registry.js';
import { createDatabaseActionExecutors } from './database-action-executors.js';
import { createDatabaseEditActionExecutors } from './edit-action-executors.js';
import { createFeedbackStatusActionExecutor } from './feedback-status-action-executor.js';
import { createPaymentsCreateActionExecutor } from './payments-create-action-executor.js';
import { createRecordsCaptureActionExecutor } from './records-capture-action-executor.js';
import type { ConfirmableActionRegistry } from './types.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import type { Logger } from '../../shared/logger/index.js';

export interface CreateDatabaseConfirmableActionRegistryOptions {
  /** feedback.updateStatus / payments.create / students.records.capture executor 字段加密 cipher（缺省 env 构建）。 */
  cipher?: FieldCipher;
  /** feedback.updateStatus executor 出站审核（仅 provider=local 生效）。 */
  moderation?: ModerationAdapter;
  /** feedback.updateStatus executor 审核结构化日志。 */
  logger?: Logger;
}

export function createDatabaseConfirmableActionRegistry(
  tx: Prisma.TransactionClient,
  options?: CreateDatabaseConfirmableActionRegistryOptions,
): ConfirmableActionRegistry {
  const executors = createDatabaseActionExecutors(tx);
  const editExecutors = createDatabaseEditActionExecutors(tx);
  const feedbackStatus = createFeedbackStatusActionExecutor({
    tx,
    cipher: options?.cipher,
    moderation: options?.moderation,
    logger: options?.logger,
  });
  const paymentsCreate = createPaymentsCreateActionExecutor({
    tx,
    cipher: options?.cipher,
  });
  const recordsCapture = createRecordsCaptureActionExecutor({
    tx,
    cipher: options?.cipher,
  });
  return createConfirmableActionRegistry({
    'scheduling.complete': executors.scheduleComplete,
    'scheduling.cancel': executors.scheduleCancel,
    'lessons.updateStatus': executors.lessonUpdateStatus,
    'students.updateStatus': executors.studentUpdateStatus,
    'students.updateProfile': editExecutors.studentUpdateProfile,
    'scheduling.reschedule': editExecutors.scheduleReschedule,
    'lessons.updateRecord': editExecutors.lessonUpdateRecord,
    'payments.update': editExecutors.paymentUpdate,
    'memos.update': editExecutors.memoUpdate,
    'feedback.updateContent': editExecutors.feedbackUpdateContent,
    'feedback.updateStatus': feedbackStatus,
    'payments.create': paymentsCreate,
    'students.records.capture': recordsCapture,
  });
}
