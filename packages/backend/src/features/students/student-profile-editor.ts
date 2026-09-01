import type { Prisma, PrismaClient, Student } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
} from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type {
  StudentData,
  StudentProfileChanges,
  StudentProfileEditor,
  UpdateStudentProfileOwnerInput,
} from './types.js';

const PROFILE_FIELDS = new Set(['name', 'grade', 'source', 'stageGoal']);

type StudentProfilePrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreateStudentProfileEditorOptions {
  prisma: StudentProfilePrismaClient;
  trustedClock: TrustedClock;
}

function hasOwn(changes: StudentProfileChanges, field: keyof StudentProfileChanges): boolean {
  return Object.hasOwn(changes, field);
}

function validateStructure(input: UpdateStudentProfileOwnerInput) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.studentId !== 'string' || input.studentId.trim() === '') {
    return err(validationError('studentId 必须是非空字符串', 'studentId'));
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
    return err(validationError('至少提供一个学生资料字段', 'changes'));
  }
  if (keys.some((key) => !PROFILE_FIELDS.has(key))) {
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

function validateFields(changes: StudentProfileChanges) {
  if (hasOwn(changes, 'name') && (typeof changes.name !== 'string' || changes.name.trim() === '')) {
    return err(validationError('学生姓名不能为空', 'name'));
  }
  if (hasOwn(changes, 'grade') && (typeof changes.grade !== 'string' || changes.grade.trim() === '')) {
    return err(validationError('年级不能为空', 'grade'));
  }
  if (hasOwn(changes, 'source') && typeof changes.source !== 'string' && changes.source !== null) {
    return err(validationError('source 必须是字符串或null', 'source'));
  }
  if (hasOwn(changes, 'stageGoal') && typeof changes.stageGoal !== 'string' && changes.stageGoal !== null) {
    return err(validationError('stageGoal 必须是字符串或null', 'stageGoal'));
  }
  return ok(undefined);
}

function isNoOp(before: Student, changes: StudentProfileChanges): boolean {
  return (
    (!hasOwn(changes, 'name') || changes.name === before.name)
    && (!hasOwn(changes, 'grade') || changes.grade === before.grade)
    && (!hasOwn(changes, 'source') || changes.source === before.source)
    && (!hasOwn(changes, 'stageGoal') || changes.stageGoal === before.stageGoal)
  );
}

function buildUpdateData(
  changes: StudentProfileChanges,
  updatedAt: Date,
): Prisma.StudentUpdateManyMutationInput {
  const data: Prisma.StudentUpdateManyMutationInput = { updatedAtTs: updatedAt };
  if (hasOwn(changes, 'name')) data.name = changes.name;
  if (hasOwn(changes, 'grade')) data.grade = changes.grade;
  if (hasOwn(changes, 'source')) data.source = changes.source;
  if (hasOwn(changes, 'stageGoal')) data.stageGoal = changes.stageGoal;
  return data;
}

function toStudentData(record: Student): StudentData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    name: record.name,
    grade: record.grade,
    source: record.source,
    currentStatus: record.currentStatus,
    stageGoal: record.stageGoal,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

export function createStudentProfileEditor(
  options: CreateStudentProfileEditorOptions,
): StudentProfileEditor {
  const { prisma, trustedClock } = options;

  return {
    async updateStudentProfile(input) {
      const structure = validateStructure(input);
      if (!structure.ok) return structure;

      const before = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
      });
      if (!before) return err(notFound('学生不存在'));

      if (
        input.expectedUpdatedAt !== undefined
        && input.expectedUpdatedAt.getTime() !== before.updatedAtTs.getTime()
      ) {
        return err(versionConflict());
      }

      const fields = validateFields(input.changes);
      if (!fields.ok) return fields;
      if (isNoOp(before, input.changes)) {
        return err(validationError('学生资料未发生变化', 'changes'));
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

      const updated = await prisma.student.updateMany({
        where: {
          id: input.studentId,
          teacherId: input.teacherId,
          updatedAtTs: before.updatedAtTs,
        },
        data: buildUpdateData(input.changes, nextToken),
      });

      if (updated.count === 0) {
        const current = await prisma.student.findFirst({
          where: { id: input.studentId, teacherId: input.teacherId },
          select: { id: true },
        });
        return current ? err(versionConflict()) : err(notFound('学生不存在'));
      }

      const after = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
      });
      if (!after) return err(internalError('学生资料更新后不可读取'));

      return ok({
        before: toStudentData(before),
        after: toStudentData(after),
      });
    },
  };
}
