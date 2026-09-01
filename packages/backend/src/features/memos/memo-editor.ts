import type { Memo, PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
} from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  MemoChanges,
  MemoData,
  MemoEditor,
  MemoJsonValue,
  MemoStatus,
  UpdateMemoOwnerInput,
} from './types.js';

const MEMO_FIELDS = new Set(['title', 'content', 'dueAt', 'tags']);

type MemoEditorPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreateMemoEditorOptions {
  prisma: MemoEditorPrismaClient;
  trustedClock: TrustedClock;
  /** P8 phase-3 批6：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

function hasOwn(changes: MemoChanges, field: keyof MemoChanges): boolean {
  return Object.hasOwn(changes, field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is MemoJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) return false;
      }
      return true;
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.some((key) => !Object.prototype.propertyIsEnumerable.call(value, key))
  ) {
    return false;
  }

  ancestors.add(value);
  try {
    return Object.values(value).every((item) => isJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]));
}

function validateStructure(input: UpdateMemoOwnerInput) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.memoId !== 'string' || input.memoId.trim() === '') {
    return err(validationError('memoId 必须是非空字符串', 'memoId'));
  }
  if (
    typeof input.changes !== 'object'
    || input.changes === null
    || Array.isArray(input.changes)
  ) {
    return err(validationError('changes 必须是对象', 'changes'));
  }
  const keys = Object.keys(input.changes);
  if (keys.length === 0) {
    return err(validationError('至少提供一个备忘字段', 'changes'));
  }
  if (keys.some((key) => !MEMO_FIELDS.has(key))) {
    return err(validationError('changes 包含不允许的字段', 'changes'));
  }
  if (
    input.expectedUpdatedAt !== undefined
    && (!(input.expectedUpdatedAt instanceof Date) || Number.isNaN(input.expectedUpdatedAt.getTime()))
  ) {
    return err(validationError('expectedUpdatedAt 无效', 'expectedUpdatedAt'));
  }
  return ok(undefined);
}

function validateFields(changes: MemoChanges) {
  if (hasOwn(changes, 'title') && (typeof changes.title !== 'string' || changes.title.trim() === '')) {
    return err(validationError('title 不能为空', 'title'));
  }
  if (
    hasOwn(changes, 'content')
    && (typeof changes.content !== 'string' || changes.content.trim() === '')
  ) {
    return err(validationError('content 不能为空', 'content'));
  }
  if (
    hasOwn(changes, 'dueAt')
    && changes.dueAt !== null
    && (!(changes.dueAt instanceof Date) || Number.isNaN(changes.dueAt.getTime()))
  ) {
    return err(validationError('dueAt 必须是有效Date或null', 'dueAt'));
  }
  if (hasOwn(changes, 'tags') && !isJsonValue(changes.tags)) {
    return err(validationError('tags 必须是JSON值或null', 'tags'));
  }
  return ok(undefined);
}

function isNoOp(before: Memo, changes: MemoChanges, cipher: FieldCipher | undefined): boolean {
  const dueAtEqual = !hasOwn(changes, 'dueAt')
    || (changes.dueAt === null
      ? before.dueAtTs === null
      : before.dueAtTs?.getTime() === changes.dueAt?.getTime());
  return (
    (!hasOwn(changes, 'title') || changes.title === before.title)
    && (!hasOwn(changes, 'content') || changes.content === decryptFieldValue(cipher, before.content))
    && dueAtEqual
    && (!hasOwn(changes, 'tags') || jsonEquals(before.tags, changes.tags))
  );
}

function buildUpdateData(
  changes: MemoChanges,
  updatedAt: Date,
  cipher: FieldCipher | undefined,
): Prisma.MemoUpdateManyMutationInput {
  const data: Prisma.MemoUpdateManyMutationInput = { updatedAtTs: updatedAt };
  if (hasOwn(changes, 'title')) data.title = changes.title;
  if (hasOwn(changes, 'content')) data.content = encryptFieldValue(cipher, changes.content as string);
  if (hasOwn(changes, 'dueAt')) {
    data.dueAtTs = changes.dueAt;
  }
  if (hasOwn(changes, 'tags')) {
    data.tags = changes.tags === null
      ? Prisma.DbNull
      : changes.tags as Prisma.InputJsonValue;
  }
  return data;
}

function toMemoData(record: Memo, cipher: FieldCipher | undefined): MemoData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    title: record.title,
    content: decryptFieldValue(cipher, record.content),
    status: record.status as MemoStatus,
    dueAt: record.dueAtTs,
    tags: record.tags,
    source: record.source,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

export function createMemoEditor(options: CreateMemoEditorOptions): MemoEditor {
  const { prisma, trustedClock } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    async updateMemo(input) {
      const structure = validateStructure(input);
      if (!structure.ok) return structure;

      const before = await prisma.memo.findFirst({
        where: { id: input.memoId, teacherId: input.teacherId },
      });
      if (!before) return err(notFound('备忘不存在'));

      if (
        input.expectedUpdatedAt !== undefined
        && input.expectedUpdatedAt.getTime() !== before.updatedAtTs.getTime()
      ) {
        return err(versionConflict());
      }

      const fields = validateFields(input.changes);
      if (!fields.ok) return fields;
      if (isNoOp(before, input.changes, cipher)) {
        return err(validationError('备忘未发生变化', 'changes'));
      }

      const clockResult = await trustedClock.now();
      if (!clockResult.ok) return clockResult;
      const nextToken = clockResult.value;
      if (
        !(nextToken instanceof Date)
        || Number.isNaN(nextToken.getTime())
        || nextToken.getTime() === before.updatedAtTs.getTime()
      ) {
        return err(internalError('数据库可信版本token不可用'));
      }

      try {
        const updated = await prisma.memo.updateMany({
          where: {
            id: input.memoId,
            teacherId: input.teacherId,
            updatedAtTs: before.updatedAtTs,
          },
          data: buildUpdateData(input.changes, nextToken, cipher),
        });

        if (updated.count === 0) {
          const current = await prisma.memo.findFirst({
            where: { id: input.memoId, teacherId: input.teacherId },
            select: { id: true },
          });
          return current ? err(versionConflict()) : err(notFound('备忘不存在'));
        }

        const after = await prisma.memo.findFirst({
          where: { id: input.memoId, teacherId: input.teacherId },
        });
        if (!after) return err(internalError('备忘更新后不可读取'));

        return ok({ before: toMemoData(before, cipher), after: toMemoData(after, cipher) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新备忘失败：${message}`));
      }
    },
  };
}
