import { adminRequest } from './client';

/**
 * 后台管理 · 平台级用量费用看板 API（契约：backend5 t28，p7-admin-panel-design.md §6 远期看板）。
 * - GET /api/v1/admin/usage/summary?from=&to=&teacherId=  平台级用量总览
 *   · from/to 必填（ISO 时间，from < to，服务端校验）
 *   · teacherId 可选（单教师钻取；缺省 = 全平台）
 *   · 返回 { from, to, teacherId?, totals, byProvider }——形状与教师侧 /usage/summary 一致
 *   · ProviderUsage 为共享库表，admin 跨教师聚合（只读不记审计）
 */

export interface AdminUsageSummaryRow {
  providerName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface AdminUsageSummary {
  from: string;
  to: string;
  /** 单教师过滤回显（缺省 undefined = 全平台） */
  teacherId?: string;
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
  };
  byProvider: AdminUsageSummaryRow[];
}

export interface AdminUsageSummaryParams {
  /** ISO 时间（from < to） */
  from: string;
  to: string;
  /** 可选：单教师钻取；空串/undefined = 全平台 */
  teacherId?: string;
}

/** GET /api/v1/admin/usage/summary → 平台级用量总览。 */
export function getAdminUsageSummary(params: AdminUsageSummaryParams): Promise<AdminUsageSummary> {
  const search = new URLSearchParams();
  search.set('from', params.from);
  search.set('to', params.to);
  if (params.teacherId !== undefined && params.teacherId.trim() !== '') {
    search.set('teacherId', params.teacherId.trim());
  }
  return adminRequest(`/admin/usage/summary?${search.toString()}`);
}
