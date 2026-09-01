import {
  err,
  ok,
  validationError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import type {
  ConfirmableActionName,
  CreatePendingActionInput,
} from '../../features/pending-action/index.js';
import type {
  CreateConfirmationGatewayOptions,
  RequestConfirmationInput,
} from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  field: string,
): Result<Record<string, unknown>, CommonError> {
  if (!isPlainObject(value)) return err(validationError(`${field} 必须是对象`, field));
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedFields.includes(key))) {
    return err(validationError(`${field} 包含不允许的字段`, field));
  }
  if (requiredFields.some((key) => !Object.hasOwn(value, key))) {
    return err(validationError(`${field} 缺少必填字段`, field));
  }
  return ok(value);
}

function nonEmptyString(value: unknown, field: string): Result<string, CommonError> {
  return typeof value === 'string' && value.trim() !== ''
    ? ok(value)
    : err(validationError(`${field} 必须是非空字符串`, field));
}

function stringOrNull(value: unknown, field: string): Result<string | null, CommonError> {
  return typeof value === 'string' || value === null
    ? ok(value)
    : err(validationError(`${field} 必须是字符串或 null`, field));
}

function positiveNumber(value: unknown, field: string): Result<number, CommonError> {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? ok(value)
    : err(validationError(`${field} 必须是正数`, field));
}

function positiveInteger(value: unknown, field: string): Result<number, CommonError> {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? ok(value)
    : err(validationError(`${field} 必须是正整数`, field));
}

const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function parseRfc3339Instant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const match = RFC3339_INSTANT.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function rfc3339Instant(value: unknown, field: string): Result<string, CommonError> {
  return typeof value === 'string' && parseRfc3339Instant(value)
    ? ok(value)
    : err(validationError(`${field} 必须是带时区的 RFC 3339 时间`, field));
}

function jsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const valid = value.length === Object.keys(value).length
      && value.every((item) => jsonValue(item, seen));
    seen.delete(value);
    return valid;
  }
  if (!isPlainObject(value)) return false;
  const valid = Object.values(value).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function parseChanges(
  value: unknown,
  validators: Readonly<Record<string, (value: unknown, field: string) => Result<unknown, CommonError>>>,
): Result<Record<string, unknown>, CommonError> {
  const parsed = exactObject(value, Object.keys(validators), [], 'changes');
  if (!parsed.ok) return parsed;
  const keys = Object.keys(parsed.value);
  if (keys.length === 0) return err(validationError('changes 至少包含一个字段', 'changes'));
  const changes: Record<string, unknown> = {};
  for (const key of keys) {
    const validated = validators[key](parsed.value[key], key);
    if (!validated.ok) return validated;
    changes[key] = validated.value;
  }
  return ok(changes);
}

const SENSITIVE_TEXT_FIELDS = new Set([
  'stageGoal',
  'progress',
  'studentState',
  'homework',
  'teacherNote',
  'note',
  'content',
]);
const SUMMARY_LIMIT = 220;

function summaryValue(field: string, value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (field === 'tags') return value === null ? 'null' : '[结构化值]';
  if (typeof value === 'string' && SENSITIVE_TEXT_FIELDS.has(field)) {
    return `[文本${value.length}字]`;
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  if (rendered === undefined) return '[未设置]';
  return rendered.length <= 48 ? rendered : `${rendered.slice(0, 47)}…`;
}

function projectionSummary(
  entity: string,
  phase: '当前' | '变更后',
  fields: readonly string[],
  read: (field: string) => unknown,
): string {
  const projection = fields.map((field) => `${field}=${summaryValue(field, read(field))}`).join('；');
  const summary = `${entity}${phase}变更字段：${projection}`;
  return summary.length <= SUMMARY_LIMIT ? summary : `${summary.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function baseIntent(
  input: RequestConfirmationInput,
  actionName: string,
  target: CreatePendingActionInput['target'],
  parameters: Record<string, unknown>,
  beforeSummary: string,
  afterSummary: string,
): CreatePendingActionInput {
  return {
    teacherId: input.teacherId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    actionName: actionName as ConfirmableActionName,
    target,
    parameters,
    beforeSummary,
    afterSummary,
  };
}

async function studentIntent(options: CreateConfirmationGatewayOptions, input: RequestConfirmationInput) {
  const args = exactObject(input.args, ['studentId', 'changes'], ['studentId', 'changes'], 'args');
  if (!args.ok) return args;
  const studentId = nonEmptyString(args.value.studentId, 'studentId');
  if (!studentId.ok) return studentId;
  const changes = parseChanges(args.value.changes, {
    name: nonEmptyString,
    grade: nonEmptyString,
    stageGoal: stringOrNull,
  });
  if (!changes.ok) return changes;
  const existing = await options.editOwners.studentProfiles.getOwnedStudentProfile({
    teacherId: input.teacherId,
    studentId: studentId.value,
  });
  if (!existing.ok) return existing;
  const fields = Object.keys(changes.value);
  const before = {
    name: existing.value.name,
    grade: existing.value.grade,
    stageGoal: existing.value.stageGoal,
  };
  return ok(baseIntent(
    input,
    'students.updateProfile',
    { type: 'Student', id: studentId.value },
    { studentId: studentId.value, changes: changes.value, expectedUpdatedAt: existing.value.updatedAt.toISOString() },
    projectionSummary('学生资料', '当前', fields, (field) => before[field as keyof typeof before]),
    projectionSummary('学生资料', '变更后', fields, (field) => changes.value[field]),
  ));
}

async function scheduleIntent(options: CreateConfirmationGatewayOptions, input: RequestConfirmationInput) {
  const args = exactObject(input.args, ['scheduleId', 'replacement'], ['scheduleId', 'replacement'], 'args');
  if (!args.ok) return args;
  const scheduleId = nonEmptyString(args.value.scheduleId, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const replacement = exactObject(
    args.value.replacement,
    ['scheduledStart', 'scheduledEnd'],
    ['scheduledStart', 'scheduledEnd'],
    'replacement',
  );
  if (!replacement.ok) return replacement;
  const scheduledStart = rfc3339Instant(replacement.value.scheduledStart, 'scheduledStart');
  if (!scheduledStart.ok) return scheduledStart;
  const scheduledEnd = rfc3339Instant(replacement.value.scheduledEnd, 'scheduledEnd');
  if (!scheduledEnd.ok) return scheduledEnd;
  const startInstant = parseRfc3339Instant(scheduledStart.value);
  const endInstant = parseRfc3339Instant(scheduledEnd.value);
  if (!startInstant || !endInstant || endInstant <= startInstant) {
    return err(validationError('scheduledEnd 必须晚于 scheduledStart', 'scheduledEnd'));
  }
  const existing = await options.editOwners.scheduleReschedules.getOwnedSchedule({
    teacherId: input.teacherId,
    scheduleId: scheduleId.value,
  });
  if (!existing.ok) return existing;
  return ok(baseIntent(
    input,
    'scheduling.reschedule',
    { type: 'Schedule', id: scheduleId.value },
    {
      scheduleId: scheduleId.value,
      replacement: { scheduledStart: scheduledStart.value, scheduledEnd: scheduledEnd.value },
      expectedUpdatedAt: existing.value.updatedAt.toISOString(),
    },
    projectionSummary('日程', '当前', ['scheduledStart', 'scheduledEnd'], (field) => (
      field === 'scheduledStart' ? existing.value.scheduledStart : existing.value.scheduledEnd
    )),
    projectionSummary('日程', '变更后', ['scheduledStart', 'scheduledEnd'], (field) => (
      field === 'scheduledStart' ? scheduledStart.value : scheduledEnd.value
    )),
  ));
}

async function lessonIntent(options: CreateConfirmationGatewayOptions, input: RequestConfirmationInput) {
  const args = exactObject(input.args, ['lessonId', 'changes'], ['lessonId', 'changes'], 'args');
  if (!args.ok) return args;
  const lessonId = nonEmptyString(args.value.lessonId, 'lessonId');
  if (!lessonId.ok) return lessonId;
  const changes = parseChanges(args.value.changes, {
    progress: stringOrNull,
    studentState: stringOrNull,
    homework: stringOrNull,
    teacherNote: stringOrNull,
  });
  if (!changes.ok) return changes;
  const existing = await options.editOwners.lessonRecords.getOwnedLesson({
    teacherId: input.teacherId,
    lessonId: lessonId.value,
  });
  if (!existing.ok) return existing;
  const fields = Object.keys(changes.value);
  const before = {
    progress: existing.value.progress,
    studentState: existing.value.studentState,
    homework: existing.value.homework,
    teacherNote: existing.value.teacherNote,
  };
  return ok(baseIntent(
    input,
    'lessons.updateRecord',
    { type: 'Lesson', id: lessonId.value },
    { lessonId: lessonId.value, changes: changes.value, expectedUpdatedAt: existing.value.updatedAt.toISOString() },
    projectionSummary('课次记录', '当前', fields, (field) => before[field as keyof typeof before]),
    projectionSummary('课次记录', '变更后', fields, (field) => changes.value[field]),
  ));
}

async function paymentIntent(options: CreateConfirmationGatewayOptions, input: RequestConfirmationInput) {
  const args = exactObject(input.args, ['paymentId', 'changes'], ['paymentId', 'changes'], 'args');
  if (!args.ok) return args;
  const paymentId = nonEmptyString(args.value.paymentId, 'paymentId');
  if (!paymentId.ok) return paymentId;
  const changes = parseChanges(args.value.changes, {
    amount: positiveNumber,
    lessonCount: positiveInteger,
    paidAt: rfc3339Instant,
    note: stringOrNull,
  });
  if (!changes.ok) return changes;
  const existing = await options.editOwners.payments.getOwnedPayment({
    teacherId: input.teacherId,
    paymentId: paymentId.value,
  });
  if (!existing.ok) return existing;
  const fields = Object.keys(changes.value);
  const before = {
    amount: existing.value.amount,
    lessonCount: existing.value.lessonCount,
    paidAt: existing.value.paidAt,
    note: existing.value.note,
  };
  return ok(baseIntent(
    input,
    'payments.update',
    { type: 'Payment', id: paymentId.value },
    { paymentId: paymentId.value, changes: changes.value, expectedUpdatedAt: existing.value.updatedAt.toISOString() },
    projectionSummary('缴费记录', '当前', fields, (field) => before[field as keyof typeof before]),
    projectionSummary('缴费记录', '变更后', fields, (field) => changes.value[field]),
  ));
}

async function memoIntent(options: CreateConfirmationGatewayOptions, input: RequestConfirmationInput) {
  const args = exactObject(input.args, ['memoId', 'changes'], ['memoId', 'changes'], 'args');
  if (!args.ok) return args;
  const memoId = nonEmptyString(args.value.memoId, 'memoId');
  if (!memoId.ok) return memoId;
  const changes = parseChanges(args.value.changes, {
    title: nonEmptyString,
    content: nonEmptyString,
    dueAt(value, field) {
      return value === null ? ok(null) : rfc3339Instant(value, field);
    },
    tags(value, field) {
      return jsonValue(value) ? ok(structuredClone(value)) : err(validationError(`${field} 必须是 JSON 值`, field));
    },
  });
  if (!changes.ok) return changes;
  const existing = await options.editOwners.memos.getOwnedMemo({
    teacherId: input.teacherId,
    memoId: memoId.value,
  });
  if (!existing.ok) return existing;
  const fields = Object.keys(changes.value);
  const before = {
    title: existing.value.title,
    content: existing.value.content,
    dueAt: existing.value.dueAt,
    tags: existing.value.tags,
  };
  return ok(baseIntent(
    input,
    'memos.update',
    { type: 'Memo', id: memoId.value },
    { memoId: memoId.value, changes: changes.value, expectedUpdatedAt: existing.value.updatedAt.toISOString() },
    projectionSummary('备忘', '当前', fields, (field) => before[field as keyof typeof before]),
    projectionSummary('备忘', '变更后', fields, (field) => changes.value[field]),
  ));
}

async function feedbackIntent(options: CreateConfirmationGatewayOptions, input: RequestConfirmationInput) {
  const args = exactObject(input.args, ['feedbackId', 'changes'], ['feedbackId', 'changes'], 'args');
  if (!args.ok) return args;
  const feedbackId = nonEmptyString(args.value.feedbackId, 'feedbackId');
  if (!feedbackId.ok) return feedbackId;
  const changes = parseChanges(args.value.changes, { title: nonEmptyString, content: nonEmptyString });
  if (!changes.ok) return changes;
  const existing = await options.editOwners.feedback.getOwnedFeedback({
    teacherId: input.teacherId,
    feedbackId: feedbackId.value,
  });
  if (!existing.ok) return existing;
  const fields = Object.keys(changes.value);
  const before = { title: existing.value.title, content: existing.value.content };
  return ok(baseIntent(
    input,
    'feedback.updateContent',
    { type: 'ParentFeedback', id: feedbackId.value },
    { feedbackId: feedbackId.value, changes: changes.value, expectedUpdatedAt: existing.value.updatedAt.toISOString() },
    projectionSummary('家长反馈', '当前', fields, (field) => before[field as keyof typeof before]),
    projectionSummary('家长反馈', '变更后', fields, (field) => changes.value[field]),
  ));
}

export async function buildEditConfirmationIntent(
  options: CreateConfirmationGatewayOptions,
  input: RequestConfirmationInput,
): Promise<Result<CreatePendingActionInput, CommonError>> {
  switch (input.toolName) {
    case 'students.updateProfile': return studentIntent(options, input);
    case 'scheduling.reschedule': return scheduleIntent(options, input);
    case 'lessons.updateRecord': return lessonIntent(options, input);
    case 'payments.update': return paymentIntent(options, input);
    case 'memos.update': return memoIntent(options, input);
    case 'feedback.updateContent': return feedbackIntent(options, input);
    default: return err(validationError('工具不支持普通编辑确认', 'toolName'));
  }
}
