import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { ok, err } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptJsonFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../field-encryption/index.js';
import type {
  ChangelogService,
  ChangelogFactory,
  RecordChangeInput,
  QueryChangeLogsInput,
  ChangeLogEntry,
  ChangeLogListResult,
  FieldDiff,
} from './types.js';
import { computeDiff } from './diff.js';

/**
 * 创建 changelog 服务实例。
 * 依赖注入 PrismaClient，便于测试和替换。
 * P8 phase-3 批4：before/after/diff 整体加密（ChangeLog 为 S1 敏感副本，设计文档 §2.1）。
 */
type ChangelogPrismaClient = PrismaClient | Prisma.TransactionClient;

export function createChangelogService(
  prisma: ChangelogPrismaClient,
  cipher?: FieldCipher,
): ChangelogService {
  const trustedClock = createDatabaseTrustedClock(prisma);
  const fieldCipher = cipher ?? createFieldCipherFromEnv();

  return {
    async recordChange(input: RecordChangeInput) {
      try {
        const diff = computeDiff(input.before, input.after);
        const now = await trustedClock.now();
        if (!now.ok) return now;
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err({ code: 'INTERNAL_ERROR' as const, message: 'changelog 可信时间不可用' });
        }

        const record = await prisma.changeLog.create({
          data: {
            teacherId: input.teacherId,
            timestampTs: now.value,
            module: input.module,
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId,
            before: input.before !== null
              ? (encryptJsonFieldValue(fieldCipher, input.before) as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            after: input.after !== null
              ? (encryptJsonFieldValue(fieldCipher, input.after) as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            diff: diff.length > 0
              ? (encryptJsonFieldValue(fieldCipher, diff) as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            source: input.source,
            operatorId: input.operatorId ?? null,
            createdAtTs: now.value,
          },
        });

        return ok(toEntry(record, fieldCipher));
      } catch (e) {
        return err({
          code: 'INTERNAL_ERROR' as const,
          message: `changelog 记录失败: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },

    async queryChangeLogs(input: QueryChangeLogsInput) {
      try {
        const page = input.page ?? 1;
        const pageSize = input.pageSize ?? 20;
        const skip = (page - 1) * pageSize;

        const where = {
          teacherId: input.teacherId,
          ...(input.module && { module: input.module }),
          ...(input.targetType && { targetType: input.targetType }),
          ...(input.targetId && { targetId: input.targetId }),
          ...(input.action && { action: input.action }),
          ...(input.dateFrom && { timestampTs: { gte: input.dateFrom } }),
          ...(input.dateTo && { timestampTs: { lte: input.dateTo } }),
        };

        const [items, total] = await Promise.all([
          prisma.changeLog.findMany({
            where,
            orderBy: { timestampTs: 'desc' },
            skip,
            take: pageSize,
          }),
          prisma.changeLog.count({ where }),
        ]);

        const result: ChangeLogListResult = {
          items: items.map((item) => toEntry(item, fieldCipher)),
          total,
        };

        return ok(result);
      } catch (e) {
        return err({
          code: 'INTERNAL_ERROR' as const,
          message: `changelog 查询失败: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
  };
}

export const defaultChangelogFactory: ChangelogFactory = createChangelogService;

/** Prisma 记录转换为 ChangeLogEntry（before/after/diff 解密——双读：明文旧行直通）。 */
function toEntry(record: any, cipher: FieldCipher | undefined): ChangeLogEntry {
  return {
    id: record.id,
    teacherId: record.teacherId,
    timestamp: record.timestampTs,
    module: record.module,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    before: decryptJsonFieldValue(cipher, record.before) as Record<string, unknown> | null,
    after: decryptJsonFieldValue(cipher, record.after) as Record<string, unknown> | null,
    diff: decryptJsonFieldValue(cipher, record.diff) as FieldDiff[] | null,
    source: record.source,
    operatorId: record.operatorId,
  };
}