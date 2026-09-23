import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { CreatePendingActionInput } from '../../features/pending-action/index.js';
import {
  completionEntrypointUnavailable,
  lessonStatusCorrectionRequired,
} from '../policies/completion-entrypoint-gate.js';
import { parseRfc3339Instant } from '../../features/feedback/rfc3339-instant.js';
import type { FeedbackStatus } from '../../features/feedback/index.js';
import {
  validateTransition,
  type ScheduleStatus,
} from '../../features/scheduling/index.js';
import {
  validateStudentTransition,
  type StudentStatus,
} from '../../features/students/index.js';
import { buildEditConfirmationIntent } from './edit-confirmation-intents.js';
import {
  CATEGORIES,
  CONFIDENCES,
  VISIBILITIES,
  IMPORTANCES,
} from '../tools/register-student-records-tools.js';
import type {
  ConfirmationGateway,
  ConfirmationGatewayOutput,
  CreateConfirmationGatewayOptions,
  RequestConfirmationInput,
} from './types.js';

function argsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, field: string) {
  const value = record?.[field];
  return typeof value === 'string' && value.trim() !== ''
    ? ok(value)
    : err(validationError(`${field} 必须是非空字符串`, field));
}

function isStudentStatus(value: string): value is StudentStatus {
  return value === 'active' || value === 'paused' || value === 'finished';
}

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

function positiveNumber(value: unknown, field: string) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? ok(value)
    : err(validationError(`${field} 必须是正数`, field));
}

function positiveInteger(value: unknown, field: string) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? ok(value)
    : err(validationError(`${field} 必须是正整数`, field));
}

// ---- P29-W1（第三最小切片）：students.records.capture 创建型确认辅助 ----

function isRecordsCategory(value: unknown): boolean {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value);
}

function isRecordsConfidence(value: unknown): boolean {
  return typeof value === 'string' && (CONFIDENCES as string[]).includes(value);
}

function isRecordsVisibility(value: unknown): boolean {
  return typeof value === 'string' && (VISIBILITIES as string[]).includes(value);
}

function isRecordsImportance(value: unknown): boolean {
  return typeof value === 'string' && (IMPORTANCES as string[]).includes(value);
}

/** 可选枚举字段：键存在时必须为合法枚举值；缺键返回 ok(undefined)。 */
function optionalRecordsEnumField(
  args: Record<string, unknown>,
  field: string,
  isValid: (value: unknown) => boolean,
  message: string,
): Result<string | undefined, CommonError> {
  if (!Object.hasOwn(args, field)) return ok(undefined);
  if (!isValid(args[field])) return err(validationError(message, field));
  return ok(args[field] as string);
}

/** 与 feedback-service.canTransition 同一语义（draft→reviewed/archived, reviewed→sent/archived, sent→archived）。 */
function canTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  if (from === to) return true;
  if (from === 'draft') return to === 'reviewed' || to === 'archived';
  if (from === 'reviewed') return to === 'sent' || to === 'archived';
  if (from === 'sent') return to === 'archived';
  return false;
}

async function createOutput(
  options: CreateConfirmationGatewayOptions,
  intent: CreatePendingActionInput,
) {
  const created = await options.pendingActions.createPendingAction(intent);
  if (!created.ok) return created;
  return ok<ConfirmationGatewayOutput>({
    status: 'pending_confirmation',
    pendingActionId: created.value.pendingAction.id,
    summary: created.value.pendingAction.afterSummary,
  });
}

async function scheduleIntent(
  options: CreateConfirmationGatewayOptions,
  input: RequestConfirmationInput,
  targetStatus: 'completed' | 'cancelled',
) {
  const scheduleId = stringField(argsRecord(input.args), 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const existing = await options.schedules.getSchedule(scheduleId.value);
  if (!existing.ok) return existing;
  if (existing.value.teacherId !== input.teacherId) return err(notFound('日程不存在'));
  const transition = validateTransition(existing.value.status as ScheduleStatus, targetStatus);
  if (!transition.ok) return transition;
  return createOutput(options, {
    teacherId: input.teacherId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    actionName: targetStatus === 'completed' ? 'scheduling.complete' : 'scheduling.cancel',
    target: { type: 'Schedule', id: scheduleId.value },
    parameters: { scheduleId: scheduleId.value },
    beforeSummary: `日程当前状态：${existing.value.status}`,
    afterSummary: `日程将更新为 ${targetStatus}`,
  });
}

async function studentIntent(
  options: CreateConfirmationGatewayOptions,
  input: RequestConfirmationInput,
) {
  const args = argsRecord(input.args);
  const studentId = stringField(args, 'studentId');
  if (!studentId.ok) return studentId;
  const status = stringField(args, 'status');
  if (!status.ok) return status;
  if (!isStudentStatus(status.value)) {
    return err(validationError('status 必须是 active/paused/finished', 'status'));
  }
  const existing = await options.students.getStudent(studentId.value);
  if (!existing.ok) return existing;
  if (existing.value.teacherId !== input.teacherId) return err(notFound('学生不存在'));
  const transition = validateStudentTransition(existing.value.currentStatus as StudentStatus, status.value);
  if (!transition.ok) return transition;
  return createOutput(options, {
    teacherId: input.teacherId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    actionName: 'students.updateStatus',
    target: { type: 'Student', id: studentId.value },
    parameters: { studentId: studentId.value, status: status.value },
    beforeSummary: `学生当前状态：${existing.value.currentStatus}`,
    afterSummary: `学生将更新为 ${status.value}`,
  });
}

async function feedbackStatusIntent(
  options: CreateConfirmationGatewayOptions,
  input: RequestConfirmationInput,
) {
  // P29-W1：参数严格 allowlist {feedbackId, status, sentAt?}——顶层或嵌套的
  // confirm/teacherId/actionToken/source/expectedUpdatedAt 及任意额外字段全部拒绝。
  const args = argsRecord(input.args);
  if (!args) return err(validationError('args 必须是对象', 'args'));
  const extraKeys = Object.keys(args).filter((key) => key !== 'feedbackId' && key !== 'status' && key !== 'sentAt');
  if (extraKeys.length > 0) return err(validationError('args 包含不允许的字段', 'args'));
  if (args.feedbackId === undefined || args.status === undefined) {
    return err(validationError('args 缺少必填字段', 'args'));
  }

  const feedbackId = stringField(args, 'feedbackId');
  if (!feedbackId.ok) return feedbackId;
  const status = stringField(args, 'status');
  if (!status.ok) return status;
  if (!isFeedbackStatus(status.value)) {
    return err(validationError('status 必须是 draft/reviewed/sent/archived', 'status'));
  }

  // sentAt 规则：仅 status=sent 可携带，且必须是带时区的严格 RFC3339（与 feedback-service 一致）。
  const hasSentAt = Object.hasOwn(args, 'sentAt');
  let sentAt: string | undefined;
  if (hasSentAt) {
    if (typeof args.sentAt !== 'string' || parseRfc3339Instant(args.sentAt) === undefined) {
      return err(validationError('sentAt 必须是带时区的严格 RFC3339 时间', 'sentAt'));
    }
    if (status.value !== 'sent') {
      return err(validationError('仅 sent 状态可提供 sentAt', 'sentAt'));
    }
    sentAt = args.sentAt;
  }

  const existing = await options.editOwners.feedback.getOwnedFeedback({
    teacherId: input.teacherId,
    feedbackId: feedbackId.value,
  });
  if (!existing.ok) return existing;
  const currentStatus = existing.value.status;
  if (!canTransition(currentStatus, status.value)) {
    return err(validationError('非法状态流转', 'status'));
  }

  return createOutput(options, {
    teacherId: input.teacherId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    actionName: 'feedback.updateStatus',
    target: { type: 'ParentFeedback', id: feedbackId.value },
    parameters: {
      feedbackId: feedbackId.value,
      status: status.value,
      ...(sentAt !== undefined && { sentAt }),
      expectedUpdatedAt: existing.value.updatedAt.toISOString(),
    },
    beforeSummary: `家长反馈当前状态：${currentStatus}`,
    afterSummary: `家长反馈将更新为 ${status.value}`,
  });
}

async function paymentsCreateIntent(
  options: CreateConfirmationGatewayOptions,
  input: RequestConfirmationInput,
) {
  // P29-W1：创建型确认。args 严格 allowlist {studentId, amount, lessonCount, paidAt, note?}——
  // 顶层或嵌套的 confirm/teacherId/actionToken/source/expectedUpdatedAt 及任意额外字段全部拒绝。
  const args = argsRecord(input.args);
  if (!args) return err(validationError('args 必须是对象', 'args'));
  const allowed = ['studentId', 'amount', 'lessonCount', 'paidAt', 'note'];
  const extraKeys = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extraKeys.length > 0) return err(validationError('args 包含不允许的字段', 'args'));
  if (args.studentId === undefined || args.amount === undefined
    || args.lessonCount === undefined || args.paidAt === undefined) {
    return err(validationError('args 缺少必填字段', 'args'));
  }

  const studentId = stringField(args, 'studentId');
  if (!studentId.ok) return studentId;
  const amount = positiveNumber(args.amount, 'amount');
  if (!amount.ok) return amount;
  const lessonCount = positiveInteger(args.lessonCount, 'lessonCount');
  if (!lessonCount.ok) return lessonCount;
  if (typeof args.paidAt !== 'string' || parseRfc3339Instant(args.paidAt) === undefined) {
    return err(validationError('paidAt 必须是带时区的严格 RFC3339 时间', 'paidAt'));
  }
  const note = args.note === undefined ? undefined : args.note;
  if (note !== undefined && typeof note !== 'string') {
    return err(validationError('note 必须是字符串', 'note'));
  }

  // 归属复检：只读当前 teacher 的学生；跨 teacher 与不存在统一 NOT_FOUND，不建 PendingAction。
  const existing = await options.students.getStudent(studentId.value);
  if (!existing.ok) return existing;
  if (existing.value.teacherId !== input.teacherId) return err(notFound('学生不存在'));

  return createOutput(options, {
    teacherId: input.teacherId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    actionName: 'payments.create',
    target: { type: 'Student', id: studentId.value },
    parameters: {
      studentId: studentId.value,
      amount: amount.value,
      lessonCount: lessonCount.value,
      paidAt: args.paidAt,
      ...(note !== undefined && { note }),
      expectedUpdatedAt: existing.value.updatedAt.toISOString(),
    },
    beforeSummary: `学生 ${existing.value.name} 当前无待确认缴费`,
    afterSummary: `将为学生 ${existing.value.name} 创建缴费：金额 ${amount.value} 元、课时 ${lessonCount.value} 节`,
  });
}

async function recordsCaptureIntent(
  options: CreateConfirmationGatewayOptions,
  input: RequestConfirmationInput,
) {
  // P29-W1：创建型确认。args 严格 allowlist
  // {studentId, category, summary, occurredAt?, sourceText?, sourceEntityType?,
  //  sourceEntityId?, confidence?, visibility?, importance?}——顶层或嵌套的
  // confirm/teacherId/actionToken/source/expectedUpdatedAt 及任意额外字段全部拒绝。
  const args = argsRecord(input.args);
  if (!args) return err(validationError('args 必须是对象', 'args'));
  const allowed = [
    'studentId',
    'category',
    'summary',
    'occurredAt',
    'sourceText',
    'sourceEntityType',
    'sourceEntityId',
    'confidence',
    'visibility',
    'importance',
  ];
  const extraKeys = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extraKeys.length > 0) return err(validationError('args 包含不允许的字段', 'args'));
  if (args.studentId === undefined || args.category === undefined || args.summary === undefined) {
    return err(validationError('args 缺少必填字段', 'args'));
  }

  const studentId = stringField(args, 'studentId');
  if (!studentId.ok) return studentId;
  const category = stringField(args, 'category');
  if (!category.ok) return category;
  if (!isRecordsCategory(category.value)) {
    return err(validationError('category 必须是合法记录类别', 'category'));
  }
  const summary = stringField(args, 'summary');
  if (!summary.ok) return summary;

  // 可选枚举字段：键存在时必须为合法枚举值（fail-closed，拒绝 null/undefined/非法字符串）。
  const confidence = optionalRecordsEnumField(
    args, 'confidence', isRecordsConfidence, 'confidence 必须是 high/medium/low',
  );
  if (!confidence.ok) return confidence;
  const visibility = optionalRecordsEnumField(
    args, 'visibility', isRecordsVisibility, 'visibility 必须是 internal_only/parent_shareable/needs_review',
  );
  if (!visibility.ok) return visibility;
  const importance = optionalRecordsEnumField(
    args, 'importance', isRecordsImportance, 'importance 必须是 normal/important/critical',
  );
  if (!importance.ok) return importance;

  // 可选时间：occurredAt 必须是带时区的严格 RFC3339（与 payments paidAt 同校验器）。
  if (Object.hasOwn(args, 'occurredAt')
    && (typeof args.occurredAt !== 'string' || parseRfc3339Instant(args.occurredAt) === undefined)) {
    return err(validationError('occurredAt 必须是带时区的严格 RFC3339 时间', 'occurredAt'));
  }
  // 可选字符串：sourceText / sourceEntityType / sourceEntityId。
  for (const field of ['sourceText', 'sourceEntityType', 'sourceEntityId']) {
    if (Object.hasOwn(args, field) && typeof args[field] !== 'string') {
      return err(validationError(`${field} 必须是字符串`, field));
    }
  }

  // 归属复检：只读当前 teacher 的学生；跨 teacher 与不存在统一 NOT_FOUND，不建 PendingAction。
  const existing = await options.students.getStudent(studentId.value);
  if (!existing.ok) return existing;
  if (existing.value.teacherId !== input.teacherId) return err(notFound('学生不存在'));

  return createOutput(options, {
    teacherId: input.teacherId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    actionName: 'students.records.capture',
    target: { type: 'Student', id: studentId.value },
    parameters: {
      studentId: studentId.value,
      category: category.value,
      summary: summary.value,
      ...(Object.hasOwn(args, 'occurredAt') && { occurredAt: args.occurredAt }),
      ...(Object.hasOwn(args, 'sourceText') && { sourceText: args.sourceText }),
      ...(Object.hasOwn(args, 'sourceEntityType') && { sourceEntityType: args.sourceEntityType }),
      ...(Object.hasOwn(args, 'sourceEntityId') && { sourceEntityId: args.sourceEntityId }),
      ...(Object.hasOwn(args, 'confidence') && { confidence: args.confidence }),
      ...(Object.hasOwn(args, 'visibility') && { visibility: args.visibility }),
      ...(Object.hasOwn(args, 'importance') && { importance: args.importance }),
      expectedUpdatedAt: existing.value.updatedAt.toISOString(),
    },
    beforeSummary: `学生 ${existing.value.name} 当前无待确认记录`,
    afterSummary: `将为学生 ${existing.value.name} 创建记录：类别 ${category.value}、重要性 ${importance.value ?? 'normal'}`,
  });
}

export function createConfirmationGateway(
  options: CreateConfirmationGatewayOptions,
): ConfirmationGateway {
  return {
    async requestConfirmation(input) {
      switch (input.toolName) {
        case 'scheduling.complete':
          // 不能为历史工具调用创建一张未来必然失败的确认卡。
          return completionEntrypointUnavailable();
        case 'scheduling.cancel':
          return scheduleIntent(options, input, 'cancelled');
        case 'lessons.updateStatus':
          return lessonStatusCorrectionRequired();
        case 'students.updateStatus':
          return studentIntent(options, input);
        case 'students.updateProfile':
        case 'scheduling.reschedule':
        case 'lessons.updateRecord':
        case 'payments.update':
        case 'memos.update':
        case 'feedback.updateContent': {
          const intent = await buildEditConfirmationIntent(options, input);
          return intent.ok ? createOutput(options, intent.value) : intent;
        }
        case 'feedback.updateStatus':
          return feedbackStatusIntent(options, input);
        case 'payments.create':
          return paymentsCreateIntent(options, input);
        case 'students.records.capture':
          return recordsCaptureIntent(options, input);
        default:
          return err(validationError('工具不支持可信确认', 'toolName'));
      }
    },
  };
}
