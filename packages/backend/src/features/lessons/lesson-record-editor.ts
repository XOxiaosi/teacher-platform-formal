import type { Lesson, Prisma, PrismaClient } from '@prisma/client';
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
  LessonData,
  LessonRecordChanges,
  LessonRecordEditor,
  UpdateLessonRecordOwnerInput,
} from './types.js';

const RECORD_FIELDS = new Set(['progress', 'studentState', 'homework', 'teacherNote']);

type LessonRecordPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreateLessonRecordEditorOptions {
  prisma: LessonRecordPrismaClient;
  trustedClock: TrustedClock;
  /** P8 phase-3 批4：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

function hasOwn(changes: LessonRecordChanges, field: keyof LessonRecordChanges): boolean {
  return Object.hasOwn(changes, field);
}

function validateStructure(input: UpdateLessonRecordOwnerInput) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.lessonId !== 'string' || input.lessonId.trim() === '') {
    return err(validationError('lessonId 必须是非空字符串', 'lessonId'));
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
    return err(validationError('至少提供一个课次记录字段', 'changes'));
  }
  if (keys.some((key) => !RECORD_FIELDS.has(key))) {
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

function validateFields(changes: LessonRecordChanges) {
  for (const field of RECORD_FIELDS) {
    if (!Object.hasOwn(changes, field)) continue;
    const value = changes[field as keyof LessonRecordChanges];
    if (typeof value !== 'string' && value !== null) {
      return err(validationError(`${field} 必须是字符串或null`, field));
    }
  }
  return ok(undefined);
}

function isNoOp(before: Lesson, changes: LessonRecordChanges, cipher: FieldCipher | undefined): boolean {
  return (
    (!hasOwn(changes, 'progress') || changes.progress === decryptOptional(cipher, before.progress))
    && (!hasOwn(changes, 'studentState') || changes.studentState === decryptOptional(cipher, before.studentState))
    && (!hasOwn(changes, 'homework') || changes.homework === decryptOptional(cipher, before.homework))
    && (!hasOwn(changes, 'teacherNote') || changes.teacherNote === decryptOptional(cipher, before.teacherNote))
  );
}

function decryptOptional(cipher: FieldCipher | undefined, value: string | null): string | null {
  return value === null ? null : decryptFieldValue(cipher, value);
}

function buildUpdateData(
  changes: LessonRecordChanges,
  updatedAt: Date,
  cipher: FieldCipher | undefined,
): Prisma.LessonUpdateManyMutationInput {
  const data: Prisma.LessonUpdateManyMutationInput = { updatedAtTs: updatedAt };
  if (hasOwn(changes, 'progress')) data.progress = encryptOptional(cipher, changes.progress);
  if (hasOwn(changes, 'studentState')) data.studentState = encryptOptional(cipher, changes.studentState);
  if (hasOwn(changes, 'homework')) data.homework = encryptOptional(cipher, changes.homework);
  if (hasOwn(changes, 'teacherNote')) data.teacherNote = encryptOptional(cipher, changes.teacherNote);
  return data;
}

function encryptOptional(cipher: FieldCipher | undefined, value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : encryptFieldValue(cipher, value);
}

function toLessonData(record: Lesson, cipher: FieldCipher | undefined): LessonData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    scheduleId: record.scheduleId,
    date: record.dateTs,
    status: record.status,
    progress: decryptOptional(cipher, record.progress),
    studentState: decryptOptional(cipher, record.studentState),
    homework: decryptOptional(cipher, record.homework),
    teacherNote: decryptOptional(cipher, record.teacherNote),
    sourceNoteId: record.sourceNoteId,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

export function createLessonRecordEditor(
  options: CreateLessonRecordEditorOptions,
): LessonRecordEditor {
  const { prisma, trustedClock } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    async updateLessonRecord(input) {
      const structure = validateStructure(input);
      if (!structure.ok) return structure;

      const before = await prisma.lesson.findFirst({
        where: { id: input.lessonId, teacherId: input.teacherId },
      });
      if (!before) return err(notFound('课次不存在'));

      if (
        input.expectedUpdatedAt !== undefined
        && input.expectedUpdatedAt.getTime() !== before.updatedAtTs.getTime()
      ) {
        return err(versionConflict());
      }

      const fields = validateFields(input.changes);
      if (!fields.ok) return fields;
      if (isNoOp(before, input.changes, cipher)) {
        return err(validationError('课次记录未发生变化', 'changes'));
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

      const updated = await prisma.lesson.updateMany({
        where: {
          id: input.lessonId,
          teacherId: input.teacherId,
          updatedAtTs: before.updatedAtTs,
        },
        data: buildUpdateData(input.changes, nextToken, cipher),
      });

      if (updated.count === 0) {
        const current = await prisma.lesson.findFirst({
          where: { id: input.lessonId, teacherId: input.teacherId },
          select: { id: true },
        });
        return current ? err(versionConflict()) : err(notFound('课次不存在'));
      }

      const after = await prisma.lesson.findFirst({
        where: { id: input.lessonId, teacherId: input.teacherId },
      });
      if (!after) return err(internalError('课次记录更新后不可读取'));

      return ok({
        before: toLessonData(before, cipher),
        after: toLessonData(after, cipher),
      });
    },
  };
}
