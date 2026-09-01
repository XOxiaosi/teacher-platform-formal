import { adminRequest } from './client';

/**
 * 后台管理 · 反馈看板 API（契约先行，p7-admin-panel-design.md §6 + feedback-board 服务契约）：
 * - GET  /api/v1/admin/feedback/summary?limit=   看板聚合（total + status/priority/category 分布 + recent）
 * - GET  /api/v1/admin/feedback?page=&pageSize=&status=&category=&priority=
 *                                                分页列表（status/category/priority 过滤，白名单校验）
 * - PATCH /api/v1/admin/feedback/:id              状态流转/关联操作（乐观锁 expectedUpdatedAt；审计由后端落库）
 *
 * 数据源：共享库 UserRequirement（admin 全量可见，无 owner 隔离）。
 * 枚举白名单与后端 features/requirements 一致（status: new/triaged/in_progress/done/archived；
 * priority: low/normal/high/urgent；category: feature/improvement/bug_report/ux/performance/privacy/other）。
 * 注意：列表/更新路由由 L3（backend5）并行挂载，本模块按上述路径定义契约；若联调路径有出入，改动集中在本文件。
 */

export type FeedbackStatus = 'new' | 'triaged' | 'in_progress' | 'done' | 'archived';
export type FeedbackPriority = 'low' | 'normal' | 'high' | 'urgent';
export type FeedbackCategory =
  | 'feature'
  | 'improvement'
  | 'bug_report'
  | 'ux'
  | 'performance'
  | 'privacy'
  | 'other';

/** 看板条目（与后端 FeedbackBoardItem 对齐；时间一律 ISO 字符串）。 */
export interface FeedbackBoardItem {
  id: string;
  teacherId: string | null;
  /** 原话留证，不可修改 */
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

export interface FeedbackListResult {
  items: FeedbackBoardItem[];
  total: number;
}

export interface FeedbackListParams {
  page?: number;
  pageSize?: number;
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  priority?: FeedbackPriority;
}

export interface FeedbackSummary {
  total: number;
  byStatus: Array<{ status: string; count: number }>;
  byPriority: Array<{ priority: string; count: number }>;
  byCategory: Array<{ category: string; count: number }>;
  recent: Array<{
    id: string;
    teacherId: string | null;
    category: string;
    priority: string;
    status: string;
    occurredAtTs: string;
  }>;
}

/** 状态流转（管理动作）：乐观锁 expectedUpdatedAt 必须等于当前 updatedAtTs。 */
export interface UpdateFeedbackStatusInput {
  requirementId: string;
  expectedUpdatedAt: string;
  status: FeedbackStatus;
}

/** GET /api/v1/admin/feedback/summary?limit= → 看板聚合。 */
export function getFeedbackSummary(limit = 20): Promise<FeedbackSummary> {
  return adminRequest(`/admin/feedback/summary?limit=${limit}`);
}

/** GET /api/v1/admin/feedback → 分页列表 + 三过滤。 */
export function listFeedback(params: FeedbackListParams = {}): Promise<FeedbackListResult> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);
  if (params.category) search.set('category', params.category);
  if (params.priority) search.set('priority', params.priority);
  const qs = search.toString();
  return adminRequest(`/admin/feedback${qs ? `?${qs}` : ''}`);
}

/** PATCH /api/v1/admin/feedback/:id → 状态流转（后端审计 feedback.triage/.schedule/.complete 等）。 */
export function updateFeedbackStatus(input: UpdateFeedbackStatusInput): Promise<FeedbackBoardItem> {
  return adminRequest(`/admin/feedback/${encodeURIComponent(input.requirementId)}`, {
    method: 'PATCH',
    body: {
      expectedUpdatedAt: input.expectedUpdatedAt,
      changes: { status: input.status },
    },
  });
}

/** 关联工件（管理动作）：只写 linkedDesignDoc/linkedTaskId/linkedCommitSha，不改状态。 */
export interface UpdateFeedbackLinksInput {
  requirementId: string;
  /** 乐观锁：必须等于当前 updatedAtTs。 */
  expectedUpdatedAt: string;
  /** 关联设计文档路径；空字符串 = 清除关联。 */
  linkedDesignDoc?: string;
  /** 关联任务 ID；空字符串 = 清除关联。 */
  linkedTaskId?: string;
  /** 关联提交 SHA；空字符串 = 清除关联。 */
  linkedCommitSha?: string;
}

/**
 * PATCH /api/v1/admin/feedback/:id → 保存关联设计文档/任务/提交
 * （后端审计 feedback.link；changes 仅含已提供字段，未提供的不触碰）。
 */
export function updateFeedbackLinks(input: UpdateFeedbackLinksInput): Promise<FeedbackBoardItem> {
  const changes: Record<string, string> = {};
  if (input.linkedDesignDoc !== undefined) changes.linkedDesignDoc = input.linkedDesignDoc;
  if (input.linkedTaskId !== undefined) changes.linkedTaskId = input.linkedTaskId;
  if (input.linkedCommitSha !== undefined) changes.linkedCommitSha = input.linkedCommitSha;
  return adminRequest(`/admin/feedback/${encodeURIComponent(input.requirementId)}`, {
    method: 'PATCH',
    body: {
      expectedUpdatedAt: input.expectedUpdatedAt,
      changes,
    },
  });
}
