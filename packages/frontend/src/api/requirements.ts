import { apiRequest } from './client';
import type { ListResult } from './types';

/**
 * P2 用户发言需求追溯（渠道线：用户反馈表单）。
 * 后端契约（t46，packages/backend/src/features/requirements）：
 * - POST   /api/v1/requirements   创建（owner 隔离：归属 session 身份 req.teacherId）
 * - GET    /api/v1/requirements   列表（自己的 + 平台级 teacherId=null）
 * - PATCH  /api/v1/requirements/:id  乐观锁更新（expectedUpdatedAt + changes；verbatimQuote 不可改）
 */

export const REQUIREMENT_CATEGORIES = [
  'feature',
  'improvement',
  'bug_report',
  'ux',
  'performance',
  'privacy',
  'other',
] as const;

export const REQUIREMENT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const REQUIREMENT_STATUSES = ['new', 'triaged', 'in_progress', 'done', 'archived'] as const;

export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface RequirementData {
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

export interface CreateRequirementRequest {
  /** 用户原话（描述），后端必填 */
  verbatimQuote: string;
  /** 标题（简短摘要） */
  contextSummary?: string;
  /** 期望行为 */
  parsedIntent?: string;
  category: RequirementCategory;
  priority?: RequirementPriority;
}

export interface RequirementChanges {
  category?: RequirementCategory;
  priority?: RequirementPriority;
}

/** POST /api/v1/requirements → 201 创建（owner 隔离）。 */
export function createRequirement(
  teacherId: string,
  body: CreateRequirementRequest,
): Promise<RequirementData> {
  return apiRequest('/requirements', { method: 'POST', teacherId, body });
}

/** GET /api/v1/requirements → 自己的 + 平台级，occurredAtTs 倒序。 */
export function listRequirements(teacherId: string): Promise<ListResult<RequirementData>> {
  return apiRequest('/requirements', { method: 'GET', teacherId });
}

/** PATCH /api/v1/requirements/:id → 乐观锁更新（expectedUpdatedAt + changes）。 */
export function updateRequirement(
  teacherId: string,
  requirementId: string,
  body: { expectedUpdatedAt: string; changes: RequirementChanges },
): Promise<RequirementData> {
  return apiRequest(`/requirements/${encodeURIComponent(requirementId)}`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}
