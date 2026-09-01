import { adminRequest } from './client';

/**
 * 后台管理 · 教师总览 API（契约先行，p7-admin-panel-design.md §6）：
 * - GET /api/v1/admin/teachers      列表（分页/status 过滤；registry 字段，不含 passwordHash）
 * - GET /api/v1/admin/teachers/:id  详情 + 懒加载聚合（学生/课程/反馈/Agent 统计，5s 超时 degraded 标记）
 *
 * 注意：后端 A3 并行开发中，本模块按 §6 契约与设计 §2.1/§2.2 定义假定响应形状；
 * 联调阶段若后端字段命名有差异，以本文件类型为对齐点（改动集中于此）。
 */

export type AdminTeacherStatus = 'active' | 'disabled';

export interface AdminTeacherListItem {
  id: string;
  email: string;
  displayName: string;
  status: AdminTeacherStatus;
  databaseName: string;
  createdAtTs: string;
  updatedAtTs: string;
}

export interface AdminTeacherListResult {
  items: AdminTeacherListItem[];
  total: number;
}

export interface AdminListTeachersParams {
  status?: AdminTeacherStatus;
  page?: number;
  pageSize?: number;
}

export interface AdminRecentExecution {
  id: string;
  status: string;
  startedAtTs: string | null;
  finishedAtTs: string | null;
  summary: string | null;
}

export interface AdminTeacherAggregates {
  studentCount: number;
  scheduleCount: number;
  lessonCount: number;
  paymentCount: number;
  feedbackCount: number;
  agentExecutionCount: number;
  /** 最近交互时间（AgentExecution 最新 startedAtTs） */
  lastInteractionAtTs: string | null;
  /** 最近 20 条 AgentExecution（设计 §2.2，阶段一无 token 用量） */
  recentExecutions: AdminRecentExecution[];
}

export interface AdminTeacherDetail {
  teacher: AdminTeacherListItem;
  /** 单库聚合 5s 超时 → 返回部分指标并标记 degraded（设计 §2.1） */
  aggregates: AdminTeacherAggregates | null;
  degraded: boolean;
  degradedReason: string | null;
}

/** GET /api/v1/admin/teachers → 分页 + status 过滤。 */
export function listTeachers(params: AdminListTeachersParams = {}): Promise<AdminTeacherListResult> {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  const qs = search.toString();
  return adminRequest(`/admin/teachers${qs ? `?${qs}` : ''}`);
}

/** GET /api/v1/admin/teachers/:id → 详情 + 懒加载聚合。 */
export function getTeacherDetail(teacherId: string): Promise<AdminTeacherDetail> {
  return adminRequest(`/admin/teachers/${encodeURIComponent(teacherId)}`);
}
