import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  ok,
  err,
  notFound,
  validationError,
  internalError,
  versionConflict,
} from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import {
  CHANGELOG_WRITE_FAILED_MESSAGE,
  defaultChangelogFactory,
  requireChangelogWrite,
  runWithAutomaticChangelogSuppressed,
  type ChangelogFactory,
} from '../../shared/changelog/index.js';
import { validateStudentRecordReviewTransition } from './state-machine.js';
import type { StudentRecordsService, StudentRecordData } from './types.js';

const CATEGORIES = [
  'assessment',
  'lesson_observation',
  'parent_communication',
  'learning_state',
  'homework',
  'goal',
  'achievement',
  'concern',
  'agreement',
  'follow_up',
  'general_note',
];
const CONFIDENCES = ['high', 'medium', 'low'];
const VISIBILITIES = ['internal_only', 'parent_shareable', 'needs_review'];
const IMPORTANCES = ['normal', 'important', 'critical'];
const AUDIT_FAILURE_PUBLIC_MESSAGE = '审计日志写入失败';

function isChangelogWriteFailure(error: unknown): boolean {
  return error instanceof Error && error.message === CHANGELOG_WRITE_FAILED_MESSAGE;
}

// 带时区 RFC3339 时间字符串（例如 2024-01-01T00:00:00.000Z / +08:00）
const RFC3339_TZ_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

type RecordPrismaClient = PrismaClient | Prisma.TransactionClient;

/** 审核乐观并发冲突哨兵：在事务内抛出以回滚（不写 ChangeLog） */
class ReviewOptimisticConflictError extends Error {
  constructor(readonly recordStillExists: boolean) {
    super('review optimistic concurrency conflict');
  }
}

export interface StudentRecordsServiceOptions {
  getClient: () => Promise<RecordPrismaClient>;
  /** P8 phase-3 批2：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
  /** 审计服务工厂（缺省真实 ChangeLog；测试可注入失败结果验证事务回滚）。 */
  changelogFactory?: ChangelogFactory;
}

function isStudentRecordsServiceOptions(
  value: RecordPrismaClient | StudentRecordsServiceOptions,
): value is StudentRecordsServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as StudentRecordsServiceOptions).getClient === 'function';
}

export function createStudentRecordsService(
  prismaOrOptions: RecordPrismaClient | StudentRecordsServiceOptions,
): StudentRecordsService {
  const getClient = isStudentRecordsServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isStudentRecordsServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();
  const changelogFactory = isStudentRecordsServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.changelogFactory ?? defaultChangelogFactory)
    : defaultChangelogFactory;

  async function resolve(): Promise<{ prisma: RecordPrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createRecord(input) {
      const { prisma, trustedClock } = await resolve();
      if (!CATEGORIES.includes(input.category)) {
        return err(validationError('记录类别不合法', 'category'));
      }
      if (input.category === 'parent_communication') {
        return err(validationError('家长沟通记录必须使用专用沟通服务', 'category'));
      }
      if (!input.summary || input.summary.trim() === '') {
        return err(validationError('摘要不能为空', 'summary'));
      }

      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) return err(notFound('学生不存在'));

      if (input.confidence !== undefined && !CONFIDENCES.includes(input.confidence)) {
        return err(validationError('置信度不合法', 'confidence'));
      }
      if (input.visibility !== undefined && !VISIBILITIES.includes(input.visibility)) {
        return err(validationError('可见性不合法', 'visibility'));
      }
      if (input.importance !== undefined && !IMPORTANCES.includes(input.importance)) {
        return err(validationError('重要性不合法', 'importance'));
      }

      if (input.sourceRecordId) {
        const source = await prisma.studentSourceRecord.findFirst({
          where: { id: input.sourceRecordId, teacherId: input.teacherId },
        });
        if (!source) return err(notFound('原始证据不存在'));
        if (source.studentId && source.studentId !== input.studentId) {
          return err(validationError('原始证据归属学生不匹配'));
        }
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const occurredAt = input.occurredAt ?? now.value;
      const source = input.source ?? 'manual';

      try {
        const record = await runWithAutomaticChangelogSuppressed(() => (prisma as PrismaClient).$transaction(async (tx) => {
          const created = await tx.studentRecord.create({
            data: {
              teacherId: input.teacherId,
              studentId: input.studentId,
              sourceRecordId: input.sourceRecordId ?? null,
              category: input.category,
              summary: encryptFieldValue(cipher, input.summary),
              occurredAtTs: occurredAt,
              structuredData:
                input.structuredData !== undefined
                  ? (encryptJsonFieldValue(cipher, input.structuredData) as unknown as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
              confidence: input.confidence ?? 'medium',
              reviewStatus: 'candidate',
              visibility: input.visibility ?? 'needs_review',
              importance: input.importance ?? 'normal',
              createdAtTs: now.value,
              updatedAtTs: now.value,
            },
          });
          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-records',
            action: 'create',
            targetType: 'StudentRecord',
            targetId: created.id,
            before: null,
            after: {
              category: created.category,
              reviewStatus: created.reviewStatus,
              visibility: created.visibility,
              importance: created.importance,
            },
            source,
          }));
          return created;
        }));

        return ok(toRecordData(record, cipher));
      } catch (e) {
        if (isChangelogWriteFailure(e)) {
          return err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE));
        }
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`创建学生记录失败：${message}`));
      }
    },

    async getOwnedRecord(input) {
      const { prisma } = await resolve();
      try {
        const record = await prisma.studentRecord.findFirst({
          where: { id: input.recordId, teacherId: input.teacherId },
        });
        return record ? ok(toRecordData(record, cipher)) : err(notFound('记录不存在'));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询学生记录失败：${message}`));
      }
    },

    async listRecordsByStudent(input) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));
      const skip = (page - 1) * pageSize;

      const where = { teacherId: input.teacherId, studentId: input.studentId };
      try {
        const [items, total] = await Promise.all([
          prisma.studentRecord.findMany({
            where,
            orderBy: { occurredAtTs: 'desc' },
            skip,
            take: pageSize,
          }),
          prisma.studentRecord.count({ where }),
        ]);

        return ok({ items: items.map((item) => toRecordData(item, cipher)), total });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询学生记录列表失败：${message}`));
      }
    },

    async reviewRecord(input) {
      const { prisma, trustedClock } = await resolve();
      if (input.visibility !== undefined && !VISIBILITIES.includes(input.visibility)) {
        return err(validationError('可见性不合法', 'visibility'));
      }

      const owner = {
        id: input.recordId,
        teacherId: input.teacherId,
        studentId: input.studentId,
      };
      const before = await prisma.studentRecord.findFirst({ where: owner });
      if (!before) return err(notFound('记录不存在'));

      const transition = validateStudentRecordReviewTransition(
        before.reviewStatus,
        input.reviewStatus,
      );
      if (!transition.ok) return transition;

      if (input.expectedUpdatedAt !== undefined) {
        const trimmed = input.expectedUpdatedAt.trim();
        const parsed = Date.parse(trimmed);
        if (!RFC3339_TZ_PATTERN.test(trimmed) || Number.isNaN(parsed)) {
          return err(
            validationError('expectedUpdatedAt 必须是带时区的 RFC3339 时间', 'expectedUpdatedAt'),
          );
        }
        if (parsed !== before.updatedAtTs.getTime()) {
          return err(versionConflict());
        }
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const source = input.source ?? 'manual';

      const data: Prisma.StudentRecordUpdateManyMutationInput = {
        reviewStatus: input.reviewStatus,
        updatedAtTs: now.value,
      };
      if (input.visibility !== undefined) {
        data.visibility = input.visibility;
      }

      let updated;
      try {
        updated = await runWithAutomaticChangelogSuppressed(() => (prisma as PrismaClient).$transaction(async (tx) => {
          const result = await tx.studentRecord.updateMany({
            where: {
              ...owner,
              updatedAtTs: before.updatedAtTs,
            },
            data,
          });

          if (result.count === 0) {
            const current = await tx.studentRecord.findFirst({
              where: owner,
              select: { id: true },
            });
            throw new ReviewOptimisticConflictError(Boolean(current));
          }

          const after = await tx.studentRecord.findFirst({ where: owner });
          if (!after) throw new Error('审核后记录不可读取');

          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-records',
            action: 'update',
            targetType: 'StudentRecord',
            targetId: input.recordId,
            before: { reviewStatus: before.reviewStatus, visibility: before.visibility },
            after: { reviewStatus: after.reviewStatus, visibility: after.visibility },
            source,
          }));
          return after;
        }));
      } catch (e) {
        if (e instanceof ReviewOptimisticConflictError) {
          return e.recordStillExists ? err(versionConflict()) : err(notFound('记录不存在'));
        }
        if (isChangelogWriteFailure(e)) {
          return err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE));
        }
        throw e;
      }

      return ok(toRecordData(updated, cipher));
    },

    async supersedeRecord(input) {
      const { prisma, trustedClock } = await resolve();
      if (input.replacement.category === 'parent_communication') {
        return err(validationError('家长沟通记录必须使用专用沟通服务', 'category'));
      }
      const old = await prisma.studentRecord.findFirst({
        where: { id: input.recordId, teacherId: input.teacherId },
      });
      if (!old) return err(notFound('记录不存在'));

      const replacement = input.replacement;
      if (!CATEGORIES.includes(replacement.category)) {
        return err(validationError('记录类别不合法', 'category'));
      }
      if (!replacement.summary || replacement.summary.trim() === '') {
        return err(validationError('摘要不能为空', 'summary'));
      }

      const newStudentId = replacement.studentId ?? old.studentId;
      const student = await prisma.student.findFirst({
        where: { id: newStudentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) return err(notFound('学生不存在'));

      if (replacement.confidence !== undefined && !CONFIDENCES.includes(replacement.confidence)) {
        return err(validationError('置信度不合法', 'confidence'));
      }
      if (replacement.visibility !== undefined && !VISIBILITIES.includes(replacement.visibility)) {
        return err(validationError('可见性不合法', 'visibility'));
      }
      if (replacement.importance !== undefined && !IMPORTANCES.includes(replacement.importance)) {
        return err(validationError('重要性不合法', 'importance'));
      }

      if (replacement.sourceRecordId) {
        const source = await prisma.studentSourceRecord.findFirst({
          where: { id: replacement.sourceRecordId, teacherId: input.teacherId },
        });
        if (!source) return err(notFound('原始证据不存在'));
        if (source.studentId && source.studentId !== newStudentId) {
          return err(validationError('原始证据归属学生不匹配'));
        }
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const occurredAt = replacement.occurredAt ?? now.value;

      try {
        const newRecord = await runWithAutomaticChangelogSuppressed(() => (prisma as PrismaClient).$transaction(async (tx) => {
          await tx.studentRecord.update({
            where: { id: input.recordId },
            data: { reviewStatus: 'superseded', updatedAtTs: now.value },
          });

          const created = await tx.studentRecord.create({
            data: {
              teacherId: input.teacherId,
              studentId: newStudentId,
              sourceRecordId: replacement.sourceRecordId ?? null,
              category: replacement.category,
              summary: encryptFieldValue(cipher, replacement.summary),
              occurredAtTs: occurredAt,
              structuredData:
                replacement.structuredData !== undefined
                  ? (encryptJsonFieldValue(cipher, replacement.structuredData) as unknown as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
              confidence: replacement.confidence ?? 'medium',
              reviewStatus: 'candidate',
              visibility: replacement.visibility ?? 'needs_review',
              importance: replacement.importance ?? 'normal',
              supersedesId: old.id,
              createdAtTs: now.value,
              updatedAtTs: now.value,
            },
          });

          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-records',
            action: 'update',
            targetType: 'StudentRecord',
            targetId: old.id,
            before: { reviewStatus: old.reviewStatus },
            after: { reviewStatus: 'superseded' },
            source: 'manual',
          }));
          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-records',
            action: 'create',
            targetType: 'StudentRecord',
            targetId: created.id,
            before: null,
            after: {
              category: created.category,
              reviewStatus: created.reviewStatus,
              supersedesId: old.id,
            },
            source: 'manual',
          }));

          return created;
        }));

        return ok(toRecordData(newRecord, cipher));
      } catch (e) {
        if (isChangelogWriteFailure(e)) {
          return err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE));
        }
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`取代学生记录失败：${message}`));
      }
    },
  };
}

function toRecordData(record: any, cipher: FieldCipher | undefined): StudentRecordData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    sourceRecordId: record.sourceRecordId,
    category: record.category,
    occurredAt: record.occurredAtTs,
    summary: decryptFieldValue(cipher, record.summary),
    structuredData: decryptJsonFieldValue(cipher, record.structuredData) as Record<string, unknown> | null,
    confidence: record.confidence,
    reviewStatus: record.reviewStatus,
    visibility: record.visibility,
    importance: record.importance,
    supersedesId: record.supersedesId,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}
