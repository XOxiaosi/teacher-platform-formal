import {
  err,
  ok,
  validationError,
  type CommonError,
  type EditCommandSource,
  type Result,
} from '@teacher-platform/contracts';
import type {
  ParentFeedbackContentChanges,
  ParentFeedbackData,
} from '../../../features/feedback/types.js';
import type {
  UpdateParentFeedbackContentCommand,
  UpdateParentFeedbackContentResult,
  UpdateParentFeedbackContentServices,
  UpdateParentFeedbackContentUseCase,
} from './types.js';

const SOURCES = new Set<EditCommandSource>([
  'manual-web',
  'agent-confirmed',
  'wechat-confirmed',
  'system',
]);
const CONTENT_FIELDS = new Set(['title', 'content']);
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface ValidatedCommand {
  teacherId: string;
  feedbackId: string;
  expectedUpdatedAt?: Date;
  source: EditCommandSource;
  changes: ParentFeedbackContentChanges;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
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
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readChanges(value: unknown): Result<ParentFeedbackContentChanges, CommonError> {
  if (!isPlainObject(value)) return err(validationError('changes 必须是对象', 'changes'));
  const keys = Object.keys(value);
  if (keys.length === 0) return err(validationError('至少提供一个反馈内容字段', 'changes'));
  if (keys.some((key) => !CONTENT_FIELDS.has(key))) {
    return err(validationError('changes 包含不允许的字段', 'changes'));
  }
  const changes: ParentFeedbackContentChanges = {};
  if (Object.hasOwn(value, 'title')) {
    if (typeof value.title !== 'string') return err(validationError('title 必须是字符串', 'title'));
    changes.title = value.title;
  }
  if (Object.hasOwn(value, 'content')) {
    if (typeof value.content !== 'string') return err(validationError('content 必须是字符串', 'content'));
    changes.content = value.content;
  }
  return ok(changes);
}

function validateCommand(
  command: UpdateParentFeedbackContentCommand,
): Result<ValidatedCommand, CommonError> {
  const input = command as unknown as Record<string, unknown>;
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.feedbackId !== 'string' || input.feedbackId.trim() === '') {
    return err(validationError('feedbackId 必须是非空字符串', 'feedbackId'));
  }
  if (typeof input.source !== 'string' || !SOURCES.has(input.source as EditCommandSource)) {
    return err(validationError('source 不合法', 'source'));
  }
  const source = input.source as EditCommandSource;
  if (source !== 'system' && input.expectedUpdatedAt === undefined) {
    return err(validationError('expectedUpdatedAt 不能为空', 'expectedUpdatedAt'));
  }
  let expectedUpdatedAt: Date | undefined;
  if (input.expectedUpdatedAt !== undefined) {
    expectedUpdatedAt = parseRfc3339Instant(input.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return err(validationError('expectedUpdatedAt 必须是带时区的RFC 3339时间', 'expectedUpdatedAt'));
    }
  }
  const changes = readChanges(input.changes);
  if (!changes.ok) return changes;
  return ok({
    teacherId: input.teacherId,
    feedbackId: input.feedbackId,
    expectedUpdatedAt,
    source,
    changes: changes.value,
  });
}

function feedbackSnapshot(feedback: ParentFeedbackData): Record<string, unknown> {
  return {
    title: feedback.title,
    content: feedback.content,
    updatedAt: feedback.updatedAt.toISOString(),
  };
}

export function createUpdateParentFeedbackContentUseCaseWithServices(
  services: UpdateParentFeedbackContentServices,
): UpdateParentFeedbackContentUseCase {
  return {
    async updateParentFeedbackContent(command) {
      const validated = validateCommand(command);
      if (!validated.ok) return validated;
      return services.transaction<UpdateParentFeedbackContentResult>(async (tx) => {
        const edited = await tx.feedback.updateParentFeedbackContent({
          teacherId: validated.value.teacherId,
          feedbackId: validated.value.feedbackId,
          expectedUpdatedAt: validated.value.expectedUpdatedAt,
          changes: validated.value.changes,
        });
        if (!edited.ok) return edited;
        const audit = await tx.changelog.recordChange({
          teacherId: validated.value.teacherId,
          module: 'feedback',
          action: 'update',
          targetType: 'ParentFeedback',
          targetId: edited.value.after.id,
          before: feedbackSnapshot(edited.value.before),
          after: feedbackSnapshot(edited.value.after),
          source: validated.value.source,
        });
        if (!audit.ok) return audit;
        return ok({ value: edited.value.after, changeLogId: audit.value.id });
      });
    },
  };
}
