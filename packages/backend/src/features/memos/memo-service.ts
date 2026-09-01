import { err, ok, notFound, validationError, internalError } from '@teacher-platform/contracts';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type { CreateMemoServiceOptions, MemoData, MemoService, MemoStatus } from './types.js';

const AGENDA_SOURCE_LIMIT = 500;

function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** 将 unknown 转换为 Prisma JSON 字段可接受的类型 */
function toPrismaJson(value: unknown): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  if (value === null || value === undefined) {
    return Prisma.JsonNull;
  }
  return value as Prisma.InputJsonValue;
}

function toMemoData(record: {
  id: string;
  teacherId: string;
  title: string;
  content: string;
  status: string;
  dueAtTs: Date | null;
  tags: unknown;
  source: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}, cipher: FieldCipher | undefined): MemoData {
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

export function createMemoService(options: CreateMemoServiceOptions): MemoService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批6：Memo.content 加密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  async function resolve(): Promise<{ prisma: PrismaClient | Prisma.TransactionClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createMemo(input) {
      const { prisma, trustedClock } = await resolve();
      if (!input.title || input.title.trim() === '') {
        return err(validationError('title 不能为空', 'title'));
      }
      if (!input.content || input.content.trim() === '') {
        return err(validationError('content 不能为空', 'content'));
      }

      try {
        const now = await trustedClock.now();
        if (!now.ok) return now;
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err(internalError('TrustedClock返回无效时间'));
        }

        const memo = await prisma.memo.create({
          data: {
            teacherId: input.teacherId,
            title: input.title,
            content: encryptFieldValue(cipher, input.content),
            dueAtTs: input.dueAt ?? null,
            tags: toPrismaJson(input.tags),
            source: input.source ?? null,
            createdAtTs: now.value,
            updatedAtTs: now.value,
          },
        });

        return ok(toMemoData(memo, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`创建 memo 失败：${message}`));
      }
    },

    async getMemo(input) {
      const { prisma } = await resolve();
      try {
        const memo = await prisma.memo.findFirst({
          where: { id: input.memoId, teacherId: input.teacherId },
        });

        if (!memo) {
          return err(notFound('备忘不存在'));
        }

        return ok(toMemoData(memo, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询 memo 失败：${message}`));
      }
    },

    async listMemos(input) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      const skip = (page - 1) * pageSize;

      try {
        const where = {
          teacherId: input.teacherId,
          ...(input.status && { status: input.status }),
          ...(input.dueBefore && {
            dueAtTs: { lte: input.dueBefore, not: null },
          }),
        };

        const [items, total] = await Promise.all([
          prisma.memo.findMany({
            where,
            orderBy: { createdAtTs: 'desc' },
            skip,
            take: pageSize,
          }),
          prisma.memo.count({ where }),
        ]);

        return ok({ items: items.map((item) => toMemoData(item, cipher)), total });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询 memos 失败：${message}`));
      }
    },

    async listAgendaMemos(input) {
      const { prisma } = await resolve();
      if (!input.teacherId.trim()) {
        return err(validationError('teacherId 无效', 'teacherId'));
      }
      if (!isValidDate(input.dueAtBefore)) {
        return err(validationError('Agenda Memo上界无效', 'dueAtBefore'));
      }
      if (input.dueAtFrom !== undefined) {
        if (!isValidDate(input.dueAtFrom) || input.dueAtFrom >= input.dueAtBefore) {
          return err(validationError('Agenda Memo下界必须早于上界', 'dueAtFrom'));
        }
      }

      try {
        const dueAt = {
          not: null,
          lt: input.dueAtBefore,
          ...(input.dueAtFrom && { gte: input.dueAtFrom }),
        };
        const where = { teacherId: input.teacherId, status: 'active', dueAtTs: dueAt };
        const [items, total] = await Promise.all([
          prisma.memo.findMany({
            where,
            orderBy: [{ dueAtTs: 'asc' }, { id: 'asc' }],
            take: AGENDA_SOURCE_LIMIT,
          }),
          prisma.memo.count({ where }),
        ]);
        return ok({ items: items.map((item) => toMemoData(item, cipher)), total });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return err(internalError(`查询 Agenda memos 失败：${message}`));
      }
    },

    async updateMemo(input) {
      const { prisma, trustedClock } = await resolve();
      // 先查询 memo
      const existing = await prisma.memo.findUnique({
        where: { id: input.memoId },
      });

      if (!existing || existing.teacherId !== input.teacherId) {
        return err(notFound('备忘不存在'));
      }

      // 校验：如果传入了 title 但 trim 后为空
      if (input.title !== undefined && input.title.trim() === '') {
        return err(validationError('title 不能为空', 'title'));
      }
      // 校验：如果传入了 content 但 trim 后为空
      if (input.content !== undefined && input.content.trim() === '') {
        return err(validationError('content 不能为空', 'content'));
      }

      // 构建更新数据
      const data: Record<string, unknown> = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.content !== undefined) data.content = input.content;
      if (input.dueAt !== undefined) {
        data.dueAtTs = input.dueAt;
      }
      if (input.tags !== undefined) data.tags = toPrismaJson(input.tags);
      if (input.source !== undefined) data.source = input.source;

      // 未传任何可更新字段
      if (Object.keys(data).length === 0) {
        return err(validationError('未传任何可更新字段'));
      }

      try {
        if (input.content !== undefined) data.content = encryptFieldValue(cipher, input.content);
        const now = await trustedClock.now();
        if (!now.ok) return now;
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err(internalError('TrustedClock返回无效时间'));
        }

        const updated = await prisma.memo.update({
          where: { id: input.memoId },
          data: { ...data, updatedAtTs: now.value },
        });

        return ok(toMemoData(updated, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新 memo 失败：${message}`));
      }
    },

    async updateMemoStatus(input) {
      const { prisma, trustedClock } = await resolve();
      // 校验 status
      const VALID_STATUSES = ['active', 'done', 'archived'];
      if (!VALID_STATUSES.includes(input.status)) {
        return err(validationError('非法状态', 'status'));
      }

      // 查询 memo
      const existing = await prisma.memo.findUnique({
        where: { id: input.memoId },
      });

      if (!existing || existing.teacherId !== input.teacherId) {
        return err(notFound('备忘不存在'));
      }

      try {
        const now = await trustedClock.now();
        if (!now.ok) return now;
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err(internalError('TrustedClock返回无效时间'));
        }

        const updated = await prisma.memo.update({
          where: { id: input.memoId },
          data: { status: input.status, updatedAtTs: now.value },
        });

        return ok(toMemoData(updated, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新 memo 状态失败：${message}`));
      }
    },

    async listDueMemos(input) {
      const { prisma } = await resolve();
      try {
        const memos = await prisma.memo.findMany({
          where: {
            teacherId: input.teacherId,
            status: 'active',
            dueAtTs: {
              not: null,
              lte: input.dueBefore,
            },
          },
          orderBy: { dueAtTs: 'asc' },
        });

        return ok(memos.map((item) => toMemoData(item, cipher)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询到期 memos 失败：${message}`));
      }
    },
  };
}
