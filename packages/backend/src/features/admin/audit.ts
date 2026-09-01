import type { Logger } from '../../shared/logger/index.js';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * 管理动作审计（P7 渠道线 A5 阶段一 + A6 阶段二，设计 §5 + QA5 要求 3）。
 *
 * 阶段一：结构化日志扩展字段（不依赖 DB，任何环境可用）：
 *   {"msg":"admin action","actor":"admin@...","action":"teacher.disable",
 *    "objectType":"teacher","objectId":"clx_..."}
 * 失败动作记 action=*.failed + detail.error（日志 grep 断言即测试验收点）。
 *
 * 阶段二（t72 A6）：AdminAuditLog 表化——recordAdminActionDb 在结构化日志之外
 * 追加一行共享库审计（append-only，应用层纪律：不 update/delete）。写库失败
 * 只记 warn 日志、绝不阻断主动作（审计是旁路，不是关键路径）。
 */

export interface AdminAuditInput {
  /** 操作者（adminToken 会话 email） */
  actor: string;
  /** 动作名（如 teacher.create / teacher.disable / backup.run / restore.run） */
  action: string;
  objectType: string;
  objectId?: string;
  detail?: Record<string, unknown>;
  /** 失败动作传入 → action 追加 .failed + error 字段 */
  error?: unknown;
  /** 来源 IP（Express req.ip；可空，仅 DB 落库） */
  ip?: string;
}

export function recordAdminAction(logger: Logger | undefined, input: AdminAuditInput): void {
  if (!logger) return;
  const action = input.error !== undefined ? `${input.action}.failed` : input.action;
  logger.info('admin action', {
    actor: input.actor,
    action,
    objectType: input.objectType,
    objectId: input.objectId,
    ...(input.detail ?? {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

export type AdminAuditLogModel = Pick<PrismaClient, 'adminAuditLog'>;

/**
 * 结构化日志 + AdminAuditLog 表落库（A6 阶段二）。
 * - 无 prisma（或表不可用）时退化为纯日志，行为与阶段一一致；
 * - 写库失败吞掉并 warn（审计旁路不阻断主动作）；
 * - detail 内联 error（失败动作 detail.error 与日志同构）。
 */
export async function recordAdminActionDb(
  prisma: AdminAuditLogModel | undefined,
  logger: Logger | undefined,
  input: AdminAuditInput,
): Promise<void> {
  recordAdminAction(logger, input);
  if (!prisma) return;
  const action = input.error !== undefined ? `${input.action}.failed` : input.action;
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorEmail: input.actor,
        action,
        objectType: input.objectType,
        objectId: input.objectId ?? null,
        detail: (input.error !== undefined
          ? { ...(input.detail ?? {}), error: input.error }
          : (input.detail ?? undefined)) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
      },
    });
  } catch (error) {
    logger?.warn('admin audit db write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
