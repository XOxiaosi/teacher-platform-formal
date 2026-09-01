import type { PrismaClient } from '@prisma/client';
import type { ChangelogService, ChangeSource } from './types.js';
import { isAutomaticChangelogSuppressed } from './suppression.js';

/**
 * Prisma 模型名到模块名的映射。
 * changeLog 不在此映射中，意味着它的写操作不被拦截。
 */
const MODEL_TO_MODULE: Record<string, string> = {
  Student: 'students',
  Schedule: 'scheduling',
  Lesson: 'lessons',
  AINote: 'ai-notes',
  Payment: 'payments',
  DailyReview: 'daily-review',
  PushRecord: 'push',
  Memo: 'memos',
  ParentFeedback: 'feedback',
};

function prismaDelegateName(model: string): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
}

/**
 * 创建带 changelog 自动记录的 Prisma 扩展。
 *
 * 拦截 create/update/delete 操作，自动记录变更日志。
 * changeLog 模型自身的写操作不被拦截（避免递归）。
 *
 * 用法：
 *   const prisma = withChangelog(basePrisma, changelogService);
 *   // 之后所有 prisma.student.create(...) 等操作自动记录 changelog
 */
export function withChangelog(prisma: PrismaClient, service: ChangelogService) {
  return prisma.$extends({
    name: 'changelog',
    query: {
      $allModels: {
        async create({ model, operation: _operation, args, query }) {
          if (isAutomaticChangelogSuppressed()) {
            return query(args);
          }

          if (!MODEL_TO_MODULE[model]) {
            return query(args);
          }

          const result = await query(args);

          await service.recordChange({
            teacherId: (result as any).teacherId,
            module: MODEL_TO_MODULE[model],
            action: 'create',
            targetType: model,
            targetId: (result as any).id,
            before: null,
            after: result as Record<string, unknown>,
            source: 'system' as ChangeSource,
          });

          return result;
        },

        async update({ model, operation: _operation, args, query }) {
          if (isAutomaticChangelogSuppressed()) {
            return query(args);
          }

          if (!MODEL_TO_MODULE[model]) {
            return query(args);
          }

          // 获取操作前的数据
          const before = await (prisma as any)[prismaDelegateName(model)].findUnique({
            where: args.where,
          });

          const result = await query(args);

          if (before) {
            await service.recordChange({
              teacherId: before.teacherId,
              module: MODEL_TO_MODULE[model],
              action: 'update',
              targetType: model,
              targetId: before.id,
              before: before as Record<string, unknown>,
              after: result as Record<string, unknown>,
              source: 'system' as ChangeSource,
            });
          }

          return result;
        },

        async delete({ model, operation: _operation, args, query }) {
          if (isAutomaticChangelogSuppressed()) {
            return query(args);
          }

          if (!MODEL_TO_MODULE[model]) {
            return query(args);
          }

          // 获取操作前的数据
          const before = await (prisma as any)[prismaDelegateName(model)].findUnique({
            where: args.where,
          });

          const result = await query(args);

          if (before) {
            await service.recordChange({
              teacherId: before.teacherId,
              module: MODEL_TO_MODULE[model],
              action: 'delete',
              targetType: model,
              targetId: before.id,
              before: before as Record<string, unknown>,
              after: null,
              source: 'system' as ChangeSource,
            });
          }

          return result;
        },
      },
    },
  });
}