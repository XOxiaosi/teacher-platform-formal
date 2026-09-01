import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ok, err, notFound, validationError, internalError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import {
  CHANGELOG_WRITE_FAILED_MESSAGE,
  defaultChangelogFactory,
  requireChangelogWrite,
  runWithAutomaticChangelogSuppressed,
  type ChangelogFactory,
} from '../../shared/changelog/index.js';
import type {
  StudentSourceRecordService,
  StudentSourceRecordData,
} from './types.js';

const SOURCE_TYPES = [
  'agent_text',
  'manual',
  'lesson',
  'assessment',
  'audio',
  'image',
  'screenshot',
  'import',
];

/** 媒体类来源：rawText 可为空（阶段一媒体入档无 OCR/转写；rawText 留待阶段二快照）。 */
const MEDIA_SOURCE_TYPES: ReadonlySet<string> = new Set(['audio', 'image', 'screenshot']);
const AUDIT_FAILURE_PUBLIC_MESSAGE = '审计日志写入失败';

function isChangelogWriteFailure(error: unknown): boolean {
  return error instanceof Error && error.message === CHANGELOG_WRITE_FAILED_MESSAGE;
}

type SourcePrismaClient = PrismaClient | Prisma.TransactionClient;

export interface StudentSourceRecordServiceOptions {
  getClient: () => Promise<SourcePrismaClient>;
  /** P8 phase-3 批2：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
  /** 审计服务工厂（缺省真实 ChangeLog；测试可注入失败结果验证事务回滚）。 */
  changelogFactory?: ChangelogFactory;
}

function isStudentSourceRecordServiceOptions(
  value: SourcePrismaClient | StudentSourceRecordServiceOptions,
): value is StudentSourceRecordServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as StudentSourceRecordServiceOptions).getClient === 'function';
}

export function createStudentSourceRecordService(
  prismaOrOptions: SourcePrismaClient | StudentSourceRecordServiceOptions,
): StudentSourceRecordService {
  const getClient = isStudentSourceRecordServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isStudentSourceRecordServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();
  const changelogFactory = isStudentSourceRecordServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.changelogFactory ?? defaultChangelogFactory)
    : defaultChangelogFactory;

  async function resolve(): Promise<{ prisma: SourcePrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async captureSource(input) {
      const { prisma, trustedClock } = await resolve();
      if (!SOURCE_TYPES.includes(input.sourceType)) {
        return err(validationError('来源类型不合法', 'sourceType'));
      }
      if (!MEDIA_SOURCE_TYPES.has(input.sourceType) && (!input.rawText || input.rawText.trim() === '')) {
        return err(validationError('原始文本不能为空', 'rawText'));
      }

      // 幂等：同一 (teacherId, sourceEntityType, sourceEntityId) 只捕获一次
      if (input.teacherId && input.sourceEntityType && input.sourceEntityId) {
        const existing = await prisma.studentSourceRecord.findFirst({
          where: {
            teacherId: input.teacherId,
            sourceEntityType: input.sourceEntityType,
            sourceEntityId: input.sourceEntityId,
          },
        });
        if (existing) {
          return ok(toSourceData(existing, cipher));
        }
      }

      // studentId 若提供：校验属于该 teacher
      if (input.studentId) {
        const student = await prisma.student.findFirst({
          where: { id: input.studentId, teacherId: input.teacherId },
          select: { id: true },
        });
        if (!student) return err(notFound('学生不存在'));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      // contentHash 由明文 rawText 计算（幂等键保持明文哈希语义，设计文档 D2）；
      // 存储的 rawText 加密（P8 phase-3 批2）。
      const contentHash = createHash('sha256').update(input.rawText).digest('hex');
      const occurredAt = input.occurredAt ?? now.value;

      try {
        const record = await prisma.studentSourceRecord.create({
          data: {
            teacherId: input.teacherId,
            studentId: input.studentId ?? null,
            sourceType: input.sourceType,
            sourceEntityType: input.sourceEntityType ?? null,
            sourceEntityId: input.sourceEntityId ?? null,
            rawText: encryptFieldValue(cipher, input.rawText),
            contentHash,
            captureStatus: input.studentId ? 'captured' : 'unresolved',
            occurredAtTs: occurredAt,
            createdAtTs: now.value,
            updatedAtTs: now.value,
          },
        });

        return ok(toSourceData(record, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`捕获原始证据失败：${message}`));
      }
    },

    async getOwnedSource(input) {
      const { prisma } = await resolve();
      const record = await prisma.studentSourceRecord.findFirst({
        where: { id: input.sourceRecordId, teacherId: input.teacherId },
      });
      return record ? ok(toSourceData(record, cipher)) : err(notFound('原始证据不存在'));
    },

    async listUnresolvedSources(input) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));
      const skip = (page - 1) * pageSize;

      const where = { teacherId: input.teacherId, captureStatus: 'unresolved' };
      const [items, total] = await Promise.all([
        prisma.studentSourceRecord.findMany({
          where,
          orderBy: { createdAtTs: 'desc' },
          skip,
          take: pageSize,
        }),
        prisma.studentSourceRecord.count({ where }),
      ]);

      return ok({ items: items.map((item) => toSourceData(item, cipher)), total });
    },

    async archiveSource(input) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.studentSourceRecord.findFirst({
        where: { id: input.sourceRecordId, teacherId: input.teacherId },
      });
      if (!existing) return err(notFound('原始证据不存在'));

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const updated = await runWithAutomaticChangelogSuppressed(() => (prisma as PrismaClient).$transaction(async (tx) => {
          const record = await tx.studentSourceRecord.update({
            where: { id: input.sourceRecordId },
            data: { captureStatus: 'archived', updatedAtTs: now.value },
          });
          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-source-record',
            action: 'update',
            targetType: 'StudentSourceRecord',
            targetId: input.sourceRecordId,
            before: { captureStatus: existing.captureStatus },
            after: { captureStatus: 'archived' },
            source: 'manual',
          }));
          return record;
        }));

        return ok(toSourceData(updated, cipher));
      } catch (e) {
        if (isChangelogWriteFailure(e)) {
          return err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE));
        }
        throw e;
      }
    },
  };
}

function toSourceData(record: any, cipher: FieldCipher | undefined): StudentSourceRecordData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    sourceType: record.sourceType,
    sourceEntityType: record.sourceEntityType,
    sourceEntityId: record.sourceEntityId,
    occurredAt: record.occurredAtTs,
    rawText: record.rawText === null ? null : decryptFieldValue(cipher, record.rawText),
    contentHash: record.contentHash,
    captureStatus: record.captureStatus,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}
