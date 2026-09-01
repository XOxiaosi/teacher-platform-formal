import type { PrismaClient } from '@prisma/client';
import { err, ok, validationError, type Result } from '@teacher-platform/contracts';
import { dbNotReadyError, type OverviewError } from './teacher-overview.js';

/**
 * 反馈看板数据源（P7 渠道线 A6，设计 §5.2）：UserRequirement 共享库聚合。
 *
 * - 只读聚合（count + groupBy + recent findMany），不触达教师库；
 * - 无 N+1：全部并行，单次往返；
 * - byCategory 按 count 降序（并列按 category 升序保证确定性）；
 * - recent 按 occurredAtTs 降序，limit 默认 20、上限 100（越界 400）；
 * - 库未就绪 → 503 DATABASE_NOT_READY（与 db-routing 语义一致）。
 */

export interface FeedbackSummaryInput {
  /** recent 条数，默认 20，上限 100 */
  limit?: number;
}

export interface FeedbackRecentItem {
  id: string;
  teacherId: string | null;
  category: string;
  priority: string;
  status: string;
  occurredAtTs: string;
}

export interface FeedbackSummary {
  total: number;
  /** 按 status 分布（new | triaged | in_progress | done | archived；规范序） */
  byStatus: Array<{ status: string; count: number }>;
  /** 按 priority 分布（urgent | high | normal | low；严重度降序） */
  byPriority: Array<{ priority: string; count: number }>;
  /** 按 category 分布（count 降序，并列 category 升序） */
  byCategory: Array<{ category: string; count: number }>;
  /** 最近需求（occurredAtTs 降序，限 limit 条） */
  recent: FeedbackRecentItem[];
}

/** 分布字段规范序（保证响应确定性；未出现的枚举值不输出）。 */
const STATUS_ORDER = ['new', 'triaged', 'in_progress', 'done', 'archived'];
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

export type FeedbackSummaryResult = Result<FeedbackSummary, OverviewError>;

export async function getFeedbackSummary(
  prisma: Pick<PrismaClient, 'userRequirement'>,
  input: FeedbackSummaryInput = {},
): Promise<FeedbackSummaryResult> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return err(validationError('limit 必须是 1-100 的整数', 'limit'));
  }

  try {
    const [total, byStatus, byPriority, byCategory, recent] = await Promise.all([
      prisma.userRequirement.count(),
      prisma.userRequirement.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.userRequirement.groupBy({ by: ['priority'], _count: { _all: true } }),
      prisma.userRequirement.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.userRequirement.findMany({
        orderBy: { occurredAtTs: 'desc' },
        take: limit,
        select: { id: true, teacherId: true, category: true, priority: true, status: true, occurredAtTs: true },
      }),
    ]);

    return ok({
      total,
      byStatus: STATUS_ORDER
        .map((status) => ({ status, count: byStatus.find((row) => row.status === status)?._count._all ?? 0 }))
        .filter((row) => row.count > 0),
      byPriority: PRIORITY_ORDER
        .map((priority) => ({ priority, count: byPriority.find((row) => row.priority === priority)?._count._all ?? 0 }))
        .filter((row) => row.count > 0),
      byCategory: byCategory
        .map((row) => ({ category: row.category, count: row._count._all }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      recent: recent.map((row) => ({
        id: row.id,
        teacherId: row.teacherId,
        category: row.category,
        priority: row.priority,
        status: row.status,
        occurredAtTs: row.occurredAtTs.toISOString(),
      })),
    });
  } catch (error) {
    if (error instanceof Error && /database|connection|ECONNREFUSED|does not exist/i.test(error.message)) {
      return err(dbNotReadyError());
    }
    throw error;
  }
}
