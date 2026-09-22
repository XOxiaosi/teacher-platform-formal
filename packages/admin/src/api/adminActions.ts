import { adminRequest } from './client';

/**
 * 后台管理 · 管理动作与看板 API（契约先行，p7-admin-panel-design.md §6 表）：
 * - POST   /admin/invitations         创建一次性教师邀请（管理员不接触教师密码）
 * - GET    /admin/invitations         查看脱敏邀请状态（不返回 token/hash）
 * - POST   /admin/invitations/:id/revoke 撤销待接受邀请
 * - PATCH  /admin/teachers/:id/status {status: active|disabled}（软停用/启用，可逆）
 * - POST   /admin/backup              {teacherId?} → {jobId}（后台执行 db-backup）
 * - GET    /admin/backup/status?jobId= 轮询结果
 * - POST   /admin/restore             ?confirm=1 演练恢复（仅 *_restore_* 目标，禁覆盖生产库）
 * - GET    /admin/health              系统健康（ready + db 巡检 + 备份状态 + 迁移版本 + metrics 摘要）
 * - GET    /admin/interactions        AgentExecution 统计（按教师/时段）
 *
 * 错误信封 {ok,error:{code,message}} 同教师端；管理动作写路径后端统一记审计（阶段一结构化日志）。
 * 注意：后端 A5 并行开发中，本模块按 §6 与设计 §2.2/§2.3 定义假定响应形状；联调以本文件类型为对齐点。
 */

export interface CreateInvitationRequest { email: string; expiresInHours: number }
export interface CreateInvitationResult { invitation: AdminInvitation; token: string }
export interface AdminInvitation { id: string; email: string; status: 'pending' | 'consumed' | 'revoked' | 'expired'; createdAtTs: string; expiresAtTs: string; consumedAtTs?: string | null; revokedAtTs?: string | null }

export function createInvitation(input: CreateInvitationRequest): Promise<CreateInvitationResult> {
  return adminRequest('/admin/invitations', { method: 'POST', body: input });
}
export function listInvitations(): Promise<{ items: AdminInvitation[] }> {
  return adminRequest('/admin/invitations');
}
export function revokeInvitation(invitationId: string): Promise<{ invitation: AdminInvitation }> {
  return adminRequest(`/admin/invitations/${encodeURIComponent(invitationId)}/revoke`, { method: 'POST' });
}

/** PATCH /admin/teachers/:id/status → {status: active|disabled}（软停用/启用）。 */
export function updateTeacherStatus(teacherId: string, status: 'active' | 'disabled'): Promise<{ id: string; status: string }> {
  return adminRequest(`/admin/teachers/${encodeURIComponent(teacherId)}/status`, {
    method: 'PATCH',
    body: { status },
  });
}

export interface BackupJob {
  jobId: string;
}

export interface BackupJobStatus {
  status: 'running' | 'succeeded' | 'failed';
  startedAtTs?: string | null;
  finishedAtTs?: string | null;
  /** succeeded：MANIFEST 摘要；failed：错误信封 message */
  detail?: string | null;
}

/** POST /admin/backup → {jobId}（后台执行 db-backup；teacherId 缺省全量）。 */
export function triggerBackup(teacherId?: string): Promise<BackupJob> {
  return adminRequest('/admin/backup', { method: 'POST', body: teacherId ? { teacherId } : undefined });
}

/** GET /admin/backup/status?jobId= → 轮询结果。 */
export function pollBackupStatus(jobId: string): Promise<BackupJobStatus> {
  return adminRequest(`/admin/backup/status?jobId=${encodeURIComponent(jobId)}`);
}

export interface RestoreRequest {
  /** 仅演练目标（teacher_db_*_restore_*），禁覆盖生产库 */
  targetDatabaseName: string;
}

/** POST /admin/restore?confirm=1 → 演练恢复（后端强制 confirm 二次确认）。 */
export function triggerRestore(input: RestoreRequest): Promise<{ ok: true }> {
  return adminRequest('/admin/restore?confirm=1', { method: 'POST', body: input });
}

// ---- 交互统计（设计 §2.2） ----

export interface AdminInteractionsStats {
  teacherId?: string;
  from?: string;
  to?: string;
  total: number;
  /** status 分布：succeeded/failed/partial/waiting_confirmation */
  byStatus: Record<string, number>;
  /** 平均/最大耗时（ms，仅终态） */
  avgDurationMs: number | null;
  maxDurationMs: number | null;
  /** 错误率 = failed / 总数 */
  errorRate: number;
  lastInteractionAtTs: string | null;
}

export interface AdminInteractionsParams {
  teacherId?: string;
  from?: string;
  to?: string;
}

/** GET /admin/interactions?teacherId=&from=&to= → AgentExecution 统计。 */
export function getInteractions(params: AdminInteractionsParams = {}): Promise<AdminInteractionsStats> {
  const search = new URLSearchParams();
  if (params.teacherId) search.set('teacherId', params.teacherId);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  const qs = search.toString();
  return adminRequest(`/admin/interactions${qs ? `?${qs}` : ''}`);
}

// ---- 系统健康（设计 §2.3） ----

export interface AdminDbHealthSummary {
  ok: number;
  missing: number;
  migrationBehind: number;
  unreachable: number;
}

export interface AdminBackupStatusSummary {
  lastRunId: string | null;
  lastRunAtTs: string | null;
  databases: number;
  success: boolean | null;
}

export interface AdminMigrationVersion {
  applied: number;
  expected: number;
}

export interface AdminMetricsSummary {
  requests5xx: number;
  p95DurationMs: number | null;
}

export interface AdminHealthData {
  ready: boolean;
  dbHealth: AdminDbHealthSummary;
  backup: AdminBackupStatusSummary;
  migration: AdminMigrationVersion;
  metrics: AdminMetricsSummary;
  message?: string | null;
}

/** GET /admin/health → 系统健康聚合。 */
export function getHealth(): Promise<AdminHealthData> {
  return adminRequest('/admin/health');
}
