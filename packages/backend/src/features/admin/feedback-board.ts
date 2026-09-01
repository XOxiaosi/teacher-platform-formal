import type { Prisma, PrismaClient } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
  type Result,
} from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { dbNotReadyError, parsePagination, type OverviewError } from './teacher-overview.js';
import {
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
} from '../../shared/requirement-domain/index.js';

/**
 * 反馈看板（P8 续篇 · §九完整实现）：UserRequirement 共享库列表/详情/管理动作。
 *
 * 与 features/feedback-summary.ts（聚合）互补：本模块是「看板操作面」——
 * - listFeedbackBoard：分页 + status/category/priority 过滤（admin 全量可见，无 owner 隔离；
 *   category 过滤为自由字符串——summary byCategory 分组即自由形态，数据可能含中英文混合分类，
 *   读侧不强约束；status/priority 白名单校验）
 * - getFeedbackBoardDetail：单条详情（404 防探测：不存在与权限不足同响应）
 * - updateFeedbackBoard：评估/排期/关联操作（updateRequirement 状态流转：
 *   new → triaged（评估中）→ in_progress（已排期/开发中）→ done（已完成）→ archived（已关闭）；
 *   关联 linkedDesignDoc/linkedTaskId/linkedCommitSha），乐观锁 expectedUpdatedAt 复用 edit 模式
 * - verbatimQuote 不可修改（原话留证）；admin 可操作平台级（teacherId=null）与任意教师需求
 *   （管理权限高于教师侧 owner 隔离）
 * - 库未就绪 → 503 DATABASE_NOT_READY（与 db-routing / summary 语义一致）
 */

// ---- 白名单（复用 features/requirements 单一事实源） ----

export const FEEDBACK_STATUSES = REQUIREMENT_STATUSES;
export const FEEDBACK_PRIORITIES = REQUIREMENT_PRIORITIES;
export const FEEDBACK_CATEGORIES = REQUIREMENT_CATEGORIES;

export type FeedbackStatus = (typeof REQUIREMENT_STATUSES)[number];
export type FeedbackPriority = (typeof REQUIREMENT_PRIORITIES)[number];
export type FeedbackCategory = (typeof REQUIREMENT_CATEGORIES)[number];

// ---- 看板条目（ISO 字符串时间，路由层直接可 JSON 化） ----

export interface FeedbackBoardItem {
  id: string;
  teacherId: string | null;
  verbatimQuote: string;
  sourceType: string | null;
  sourceDbName: string | null;
  sourceTurnId: string | null;
  contextSummary: string | null;
  occurredAtTs: string;
  parsedIntent: string | null;
  category: string;
  priority: string;
  status: string;
  linkedDesignDoc: string | null;
  linkedTaskId: string | null;
  linkedCommitSha: string | null;
  createdAtTs: string;
  updatedAtTs: string;
}

// ---- 列表 ----

export interface ListFeedbackBoardInput {
  page?: unknown;
  pageSize?: unknown;
  status?: string;
  category?: string;
  priority?: string;
}

export type ListFeedbackBoardResult = Result<{ items: FeedbackBoardItem[]; total: number }, OverviewError>;

/** 列表：分页 + 三过滤（status/priority 白名单；category 自由字符串——见模块头注释）；orderBy occurredAtTs 降序。 */
export async function listFeedbackBoard(
  prisma: Pick<PrismaClient, 'userRequirement'>,
  input: ListFeedbackBoardInput,
): Promise<ListFeedbackBoardResult> {
  if (input.status !== undefined && !FEEDBACK_STATUSES.includes(input.status as FeedbackStatus)) {
    return err(validationError(`status 只能是 ${FEEDBACK_STATUSES.join('|')}`, 'status'));
  }
  if (input.priority !== undefined && !FEEDBACK_PRIORITIES.includes(input.priority as FeedbackPriority)) {
    return err(validationError(`priority 只能是 ${FEEDBACK_PRIORITIES.join('|')}`, 'priority'));
  }
  const pagination = parsePagination(input.page, input.pageSize);
  if (!pagination.ok) return pagination;

  const where: Prisma.UserRequirementWhereInput = {
    ...(input.status !== undefined && { status: input.status }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.priority !== undefined && { priority: input.priority }),
  };
  try {
    const [items, total] = await Promise.all([
      prisma.userRequirement.findMany({
        where,
        orderBy: { occurredAtTs: 'desc' },
        skip: (pagination.value.page - 1) * pagination.value.pageSize,
        take: pagination.value.pageSize,
      }),
      prisma.userRequirement.count({ where }),
    ]);
    return ok({ items: items.map(toFeedbackBoardItem), total });
  } catch (error) {
    if (error instanceof Error && /database|connection|ECONNREFUSED|does not exist/i.test(error.message)) {
      return err(dbNotReadyError());
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`反馈列表查询失败：${message}`));
  }
}

// ---- 详情 ----

export async function getFeedbackBoardDetail(
  prisma: Pick<PrismaClient, 'userRequirement'>,
  requirementId: string,
): Promise<Result<FeedbackBoardItem, OverviewError>> {
  try {
    const record = await prisma.userRequirement.findUnique({ where: { id: requirementId } });
    if (!record) return err(notFound('反馈不存在'));
    return ok(toFeedbackBoardItem(record));
  } catch (error) {
    if (error instanceof Error && /database|connection|ECONNREFUSED|does not exist/i.test(error.message)) {
      return err(dbNotReadyError());
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`反馈详情查询失败：${message}`));
  }
}

// ---- 管理动作（评估/排期/关联，乐观锁 expectedUpdatedAt） ----

export interface UpdateFeedbackBoardChanges {
  sourceType?: string;
  contextSummary?: string;
  parsedIntent?: string;
  category?: string;
  priority?: string;
  status?: string;
  linkedDesignDoc?: string;
  linkedTaskId?: string;
  linkedCommitSha?: string;
}

export interface UpdateFeedbackBoardInput {
  requirementId: string;
  expectedUpdatedAt: string;
  changes: UpdateFeedbackBoardChanges;
}

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * 管理动作（管理员 updateRequirement）：状态流转 + 关联操作。
 * - 乐观锁：expectedUpdatedAt 必须等于当前 updatedAtTs（RFC3339 带时区），stale → 409 VERSION_CONFLICT
 * - admin 无 owner 隔离：可更新平台级（teacherId=null）与任意教师需求
 * - verbatimQuote 不可修改（changes 类型不含该字段，天然拒绝）
 * - updatedAtTs 走 TrustedClock（D47/D48 时间矩阵：TRUSTED_DB）
 */
export async function updateFeedbackBoard(
  prisma: Pick<PrismaClient, 'userRequirement' | '$queryRaw'>,
  input: UpdateFeedbackBoardInput,
): Promise<Result<FeedbackBoardItem, OverviewError>> {
  const trimmed = input.expectedUpdatedAt.trim();
  const parsed = Date.parse(trimmed);
  if (!RFC3339_PATTERN.test(trimmed) || Number.isNaN(parsed)) {
    return err(validationError('expectedUpdatedAt 必须是带时区的 RFC3339 时间', 'expectedUpdatedAt'));
  }
  const changes = input.changes;
  if (changes.category !== undefined && !FEEDBACK_CATEGORIES.includes(changes.category as FeedbackCategory)) {
    return err(validationError('category 不合法', 'category'));
  }
  if (changes.priority !== undefined && !FEEDBACK_PRIORITIES.includes(changes.priority as FeedbackPriority)) {
    return err(validationError(`priority 只能是 ${FEEDBACK_PRIORITIES.join('|')}`, 'priority'));
  }
  if (changes.status !== undefined && !FEEDBACK_STATUSES.includes(changes.status as FeedbackStatus)) {
    return err(validationError(`status 只能是 ${FEEDBACK_STATUSES.join('|')}`, 'status'));
  }

  const trustedClock = createDatabaseTrustedClock(prisma);
  const now = await trustedClock.now();
  if (!now.ok) return now;
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }

  try {
    const existing = await prisma.userRequirement.findUnique({ where: { id: input.requirementId } });
    if (!existing) return err(notFound('反馈不存在'));
    if (parsed !== existing.updatedAtTs.getTime()) {
      return err(versionConflict());
    }
    const updated = await prisma.userRequirement.update({
      where: { id: input.requirementId },
      data: {
        ...(changes.sourceType !== undefined && { sourceType: changes.sourceType }),
        ...(changes.contextSummary !== undefined && { contextSummary: changes.contextSummary }),
        ...(changes.parsedIntent !== undefined && { parsedIntent: changes.parsedIntent }),
        ...(changes.category !== undefined && { category: changes.category }),
        ...(changes.priority !== undefined && { priority: changes.priority }),
        ...(changes.status !== undefined && { status: changes.status }),
        ...(changes.linkedDesignDoc !== undefined && { linkedDesignDoc: changes.linkedDesignDoc }),
        ...(changes.linkedTaskId !== undefined && { linkedTaskId: changes.linkedTaskId }),
        ...(changes.linkedCommitSha !== undefined && { linkedCommitSha: changes.linkedCommitSha }),
        updatedAtTs: now.value,
      },
    });
    return ok(toFeedbackBoardItem(updated));
  } catch (error) {
    if (error instanceof Error && /database|connection|ECONNREFUSED|does not exist/i.test(error.message)) {
      return err(dbNotReadyError());
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`反馈更新失败：${message}`));
  }
}

// ---- 审计动作名（可 grep：feedback.triage / feedback.schedule / ...） ----

/**
 * 根据变更派生审计动作名（管理动作语义化）：
 * - 状态流转：new→triaged=feedback.triage（评估）、→in_progress=feedback.schedule（排期/开发中）、
 *   →done=feedback.complete（完成）、→archived=feedback.archive（关闭）
 * - 无 status 变更但带关联字段 → feedback.link（关联设计文档/任务/提交）
 * - 其余编辑 → feedback.update
 */
export function feedbackActionForChanges(changes: UpdateFeedbackBoardChanges): string {
  if (changes.status !== undefined) {
    switch (changes.status) {
      case 'triaged':
        return 'feedback.triage';
      case 'in_progress':
        return 'feedback.schedule';
      case 'done':
        return 'feedback.complete';
      case 'archived':
        return 'feedback.archive';
      default:
        return 'feedback.update';
    }
  }
  if (
    changes.linkedDesignDoc !== undefined
    || changes.linkedTaskId !== undefined
    || changes.linkedCommitSha !== undefined
  ) {
    return 'feedback.link';
  }
  return 'feedback.update';
}

// ---- 映射 ----

function toFeedbackBoardItem(record: {
  id: string;
  teacherId: string | null;
  verbatimQuote: string;
  sourceType: string | null;
  sourceDbName: string | null;
  sourceTurnId: string | null;
  contextSummary: string | null;
  occurredAtTs: Date;
  parsedIntent: string | null;
  category: string;
  priority: string;
  status: string;
  linkedDesignDoc: string | null;
  linkedTaskId: string | null;
  linkedCommitSha: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}): FeedbackBoardItem {
  return {
    id: record.id,
    teacherId: record.teacherId,
    verbatimQuote: record.verbatimQuote,
    sourceType: record.sourceType,
    sourceDbName: record.sourceDbName,
    sourceTurnId: record.sourceTurnId,
    contextSummary: record.contextSummary,
    occurredAtTs: record.occurredAtTs.toISOString(),
    parsedIntent: record.parsedIntent,
    category: record.category,
    priority: record.priority,
    status: record.status,
    linkedDesignDoc: record.linkedDesignDoc,
    linkedTaskId: record.linkedTaskId,
    linkedCommitSha: record.linkedCommitSha,
    createdAtTs: record.createdAtTs.toISOString(),
    updatedAtTs: record.updatedAtTs.toISOString(),
  };
}
