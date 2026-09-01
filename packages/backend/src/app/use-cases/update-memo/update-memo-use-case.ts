import {
  err,
  ok,
  validationError,
  type CommonError,
  type EditCommandSource,
  type Result,
} from '@teacher-platform/contracts';
import type {
  MemoChanges,
  MemoData,
  MemoJsonValue,
} from '../../../features/memos/types.js';
import type {
  UpdateMemoCommand,
  UpdateMemoResult,
  UpdateMemoServices,
  UpdateMemoUseCase,
} from './types.js';

const SOURCES = new Set<EditCommandSource>([
  'manual-web',
  'agent-confirmed',
  'wechat-confirmed',
  'system',
]);
const MEMO_FIELDS = new Set(['title', 'content', 'dueAt', 'tags']);
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface ValidatedCommand {
  teacherId: string;
  memoId: string;
  expectedUpdatedAt?: Date;
  source: EditCommandSource;
  changes: MemoChanges;
}

type JsonReadResult =
  | { valid: true; value: MemoJsonValue }
  | { valid: false };

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
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readJsonValue(value: unknown, ancestors = new Set<object>()): JsonReadResult {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { valid: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { valid: true, value }
      : { valid: false };
  }
  if (typeof value !== 'object') return { valid: false };
  if (ancestors.has(value)) return { valid: false };

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      const output: MemoJsonValue[] = [];
      for (const item of value) {
        const parsed = readJsonValue(item, ancestors);
        if (!parsed.valid) return parsed;
        output.push(parsed.value);
      }
      return { valid: true, value: output };
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) return { valid: false };
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.some((key) => !Object.prototype.propertyIsEnumerable.call(value, key))
  ) {
    return { valid: false };
  }

  ancestors.add(value);
  try {
    const entries: Array<[string, MemoJsonValue]> = [];
    for (const [key, item] of Object.entries(value)) {
      const parsed = readJsonValue(item, ancestors);
      if (!parsed.valid) return parsed;
      entries.push([key, parsed.value]);
    }
    return { valid: true, value: Object.fromEntries(entries) };
  } finally {
    ancestors.delete(value);
  }
}

function readChanges(value: unknown): Result<MemoChanges, CommonError> {
  if (!isPlainObject(value)) {
    return err(validationError('changes 必须是对象', 'changes'));
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return err(validationError('至少提供一个备忘字段', 'changes'));
  }
  if (keys.some((key) => !MEMO_FIELDS.has(key))) {
    return err(validationError('changes 包含不允许的字段', 'changes'));
  }

  const changes: MemoChanges = {};
  if (Object.hasOwn(value, 'title')) {
    if (typeof value.title !== 'string') return err(validationError('title 必须是字符串', 'title'));
    changes.title = value.title;
  }
  if (Object.hasOwn(value, 'content')) {
    if (typeof value.content !== 'string') {
      return err(validationError('content 必须是字符串', 'content'));
    }
    changes.content = value.content;
  }
  if (Object.hasOwn(value, 'dueAt')) {
    if (value.dueAt === null) {
      changes.dueAt = null;
    } else {
      const dueAt = parseRfc3339Instant(value.dueAt);
      if (!dueAt) return err(validationError('dueAt 必须是带时区的RFC 3339时间或null', 'dueAt'));
      changes.dueAt = dueAt;
    }
  }
  if (Object.hasOwn(value, 'tags')) {
    let tags: JsonReadResult;
    try {
      tags = readJsonValue(value.tags);
    } catch {
      return err(validationError('tags 必须是JSON值或null', 'tags'));
    }
    if (!tags.valid) return err(validationError('tags 必须是JSON值或null', 'tags'));
    changes.tags = tags.value;
  }
  return ok(changes);
}

function validateCommand(command: UpdateMemoCommand): Result<ValidatedCommand, CommonError> {
  const input = command as unknown as Record<string, unknown>;
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.memoId !== 'string' || input.memoId.trim() === '') {
    return err(validationError('memoId 必须是非空字符串', 'memoId'));
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
    memoId: input.memoId,
    expectedUpdatedAt,
    source,
    changes: changes.value,
  });
}

function memoSnapshot(memo: MemoData): Record<string, unknown> {
  return {
    title: memo.title,
    content: memo.content,
    dueAt: memo.dueAt?.toISOString() ?? null,
    tags: memo.tags,
    updatedAt: memo.updatedAt.toISOString(),
  };
}

export function createUpdateMemoUseCaseWithServices(
  services: UpdateMemoServices,
): UpdateMemoUseCase {
  return {
    async updateMemo(command) {
      const validated = validateCommand(command);
      if (!validated.ok) return validated;

      return services.transaction<UpdateMemoResult>(async (tx) => {
        const edited = await tx.memos.updateMemo({
          teacherId: validated.value.teacherId,
          memoId: validated.value.memoId,
          expectedUpdatedAt: validated.value.expectedUpdatedAt,
          changes: validated.value.changes,
        });
        if (!edited.ok) return edited;

        const audit = await tx.changelog.recordChange({
          teacherId: validated.value.teacherId,
          module: 'memos',
          action: 'update',
          targetType: 'Memo',
          targetId: edited.value.after.id,
          before: memoSnapshot(edited.value.before),
          after: memoSnapshot(edited.value.after),
          source: validated.value.source,
        });
        if (!audit.ok) return audit;

        return ok({
          value: edited.value.after,
          changeLogId: audit.value.id,
        });
      });
    },
  };
}
