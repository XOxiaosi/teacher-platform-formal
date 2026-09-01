import {
  err,
  ok,
  validationError,
  type CommonError,
  type EditCommandSource,
  type Result,
} from '@teacher-platform/contracts';
import type { ScheduleData } from '../../../features/scheduling/types.js';
import type {
  RescheduleLessonCommand,
  RescheduleLessonOwnerInput,
  RescheduleLessonResult,
  RescheduleLessonServices,
  RescheduleLessonUseCase,
} from './types.js';

const SOURCES = new Set<EditCommandSource>([
  'manual-web',
  'agent-confirmed',
  'wechat-confirmed',
  'system',
]);
const REPLACEMENT_FIELDS = new Set(['scheduledStart', 'scheduledEnd']);
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface ValidatedCommand extends RescheduleLessonOwnerInput {
  source: EditCommandSource;
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
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return undefined;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function validateCommand(
  command: RescheduleLessonCommand,
): Result<ValidatedCommand, CommonError> {
  const input = command as unknown as Record<string, unknown>;
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.scheduleId !== 'string' || input.scheduleId.trim() === '') {
    return err(validationError('scheduleId 必须是非空字符串', 'scheduleId'));
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

  if (!isPlainObject(input.replacement)) {
    return err(validationError('replacement 必须是对象', 'replacement'));
  }
  const replacementKeys = Object.keys(input.replacement);
  if (
    replacementKeys.length !== 2
    || replacementKeys.some((key) => !REPLACEMENT_FIELDS.has(key))
    || !Object.hasOwn(input.replacement, 'scheduledStart')
    || !Object.hasOwn(input.replacement, 'scheduledEnd')
  ) {
    return err(validationError('replacement 必须且只能包含成对时间', 'replacement'));
  }

  const scheduledStart = parseRfc3339Instant(input.replacement.scheduledStart);
  if (!scheduledStart) {
    return err(validationError('scheduledStart 必须是带时区的RFC 3339时间', 'scheduledStart'));
  }
  const scheduledEnd = parseRfc3339Instant(input.replacement.scheduledEnd);
  if (!scheduledEnd) {
    return err(validationError('scheduledEnd 必须是带时区的RFC 3339时间', 'scheduledEnd'));
  }
  if (scheduledEnd <= scheduledStart) {
    return err(validationError('scheduledEnd 必须晚于scheduledStart', 'scheduledEnd'));
  }

  return ok({
    teacherId: input.teacherId,
    scheduleId: input.scheduleId,
    expectedUpdatedAt,
    source,
    replacement: { scheduledStart, scheduledEnd },
  });
}

function originalSnapshot(schedule: ScheduleData): Record<string, unknown> {
  return {
    status: schedule.status,
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

function replacementSnapshot(schedule: ScheduleData): Record<string, unknown> {
  return {
    studentId: schedule.studentId,
    type: schedule.type,
    title: schedule.title,
    scheduledStart: schedule.scheduledStart.toISOString(),
    scheduledEnd: schedule.scheduledEnd.toISOString(),
    status: schedule.status,
    confidence: schedule.confidence,
    pendingFields: schedule.pendingFields,
    sourceInput: schedule.sourceInput,
    parentId: schedule.parentId,
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

export function createRescheduleLessonUseCaseWithServices(
  services: RescheduleLessonServices,
): RescheduleLessonUseCase {
  return {
    async rescheduleLesson(command) {
      const validated = validateCommand(command);
      if (!validated.ok) return validated;

      return services.transaction<RescheduleLessonResult>(async (tx) => {
        const rescheduled = await tx.scheduling.rescheduleLesson({
          teacherId: validated.value.teacherId,
          scheduleId: validated.value.scheduleId,
          expectedUpdatedAt: validated.value.expectedUpdatedAt,
          replacement: validated.value.replacement,
        });
        if (!rescheduled.ok) return rescheduled;

        const originalAudit = await tx.changelog.recordChange({
          teacherId: validated.value.teacherId,
          module: 'scheduling',
          action: 'update',
          targetType: 'Schedule',
          targetId: rescheduled.value.original.id,
          before: originalSnapshot(rescheduled.value.beforeOriginal),
          after: originalSnapshot(rescheduled.value.original),
          source: validated.value.source,
        });
        if (!originalAudit.ok) return originalAudit;

        const replacementAudit = await tx.changelog.recordChange({
          teacherId: validated.value.teacherId,
          module: 'scheduling',
          action: 'create',
          targetType: 'Schedule',
          targetId: rescheduled.value.replacement.id,
          before: null,
          after: replacementSnapshot(rescheduled.value.replacement),
          source: validated.value.source,
        });
        if (!replacementAudit.ok) return replacementAudit;

        return ok({
          original: rescheduled.value.original,
          replacement: rescheduled.value.replacement,
          conflicts: rescheduled.value.conflicts,
          changeLogIds: {
            original: originalAudit.value.id,
            replacement: replacementAudit.value.id,
          },
        });
      });
    },
  };
}
