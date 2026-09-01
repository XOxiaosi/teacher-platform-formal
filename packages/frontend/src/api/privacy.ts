import { apiDownloadBlob, apiRequest } from './client';

/**
 * 隐私自助 API 契约（P8 t29 backend /api/v1/privacy/*，P9 前端接线；P14 t5 zip 单包）。
 *
 * - 身份：session cookie（credentials:'include'）。owner 隔离由后端
 *   requireAuth → req.teacherId 保证——前端绝不传 teacherId/他人标识，
 *   零越权：仅能操作自己。
 * - 导出：POST /privacy/export {format:'zip'} → 202 {jobId} → 轮询
 *   GET /privacy/export/status?jobId= → succeeded 后
 *   GET /privacy/export/download?jobId= 取 application/zip 附件
 *   export-<teacherId>.zip（含 manifest/account/tables/media，服务端下载后清理产物）。
 *   注：缺省 format='json'（{manifest,account,tables} JSON 附件）仍受支持（exportDownload）。
 * - 注销：POST /privacy/deactivate {email,password,confirm} → 200 {jobId,status,result?}；
 *   真实删除由服务端 deactivate-teacher --confirm 门禁执行，前端永不直接删除。
 *   错误：邮箱不匹配/密码错/confirm 错 → 400 VALIDATION_ERROR；限流 → 429 RATE_LIMITED。
 */

export type PrivacyJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** 导出产物格式（P14 t5）：'zip' 单包（含媒体文件）| 'json'（缺省，JSON 附件）。 */
export type PrivacyExportFormat = 'json' | 'zip';

/**
 * 导出任务成功 result（= ops export-teacher-data.mjs stdout 尾行 JSON 汇总；
 * 后端动态 JSON，字段均选填，前端只读所需子集）。
 * mediaFiles/mediaBytes 供前端提示「媒体文件较多，导出可能需要更久」与完成摘要。
 */
export interface PrivacyExportJobResult {
  tool?: string;
  teacherId?: string | null;
  email?: string | null;
  databaseName?: string;
  out?: string;
  tables?: number;
  totalRows?: number;
  mediaFiles?: number;
  mediaBytes?: number;
  accountSha256?: string;
  exportedAt?: string;
}

/** GET /privacy/export/status 返回体（result/error 仅在终态出现）。 */
export interface PrivacyExportJob {
  jobId: string;
  status: PrivacyJobStatus;
  result?: PrivacyExportJobResult;
  error?: string;
}

/** GET /privacy/export/download 返回体（format='json'）：manifest 清单 + 账号信息 + 业务表（JSONL 解析为数组）。 */
export interface PrivacyExportData {
  manifest: unknown;
  account: unknown;
  tables: Record<string, unknown[]>;
}

/** zip 单包下载结果：blob 二进制 + Content-Disposition 解析出的文件名。 */
export interface PrivacyZipDownload {
  blob: Blob;
  /** 后端 Content-Disposition filename*（UTF-8''export-<teacherId>.zip）；解析失败为 null */
  filename: string | null;
}

export interface PrivacyDeactivateInput {
  email: string;
  password: string;
  /** 二次确认：=注册邮箱（或服务端固定短语），服务端门禁校验。 */
  confirm: string;
}

export interface PrivacyDeactivateResult {
  jobId: string;
  status: PrivacyJobStatus;
  result?: unknown;
}

/** POST /api/v1/privacy/export → 202 {jobId}（owner 由 session 决定；format 缺省 'json'）。 */
export function exportPrivacy(input?: { format?: PrivacyExportFormat }): Promise<{ jobId: string }> {
  const body = input?.format === 'zip' ? { format: 'zip' } : undefined;
  return apiRequest<{ jobId: string }>('/privacy/export', {
    method: 'POST',
    ...(body !== undefined ? { body } : {}),
  });
}

/** GET /api/v1/privacy/export/status?jobId= → 轮询终态（jobId 不存在/他人 → 404）。 */
export function exportStatus(jobId: string): Promise<PrivacyExportJob> {
  return apiRequest<PrivacyExportJob>(`/privacy/export/status?jobId=${encodeURIComponent(jobId)}`, { method: 'GET' });
}

/** GET /api/v1/privacy/export/download?jobId= → JSON 附件 {manifest,account,tables}（format='json' 任务）。 */
export function exportDownload(jobId: string): Promise<PrivacyExportData> {
  return apiRequest<PrivacyExportData>(`/privacy/export/download?jobId=${encodeURIComponent(jobId)}`, { method: 'GET' });
}

/** GET /api/v1/privacy/export/download?jobId= → zip 单包 blob（format='zip' 任务；application/zip）。 */
export async function exportDownloadZip(jobId: string): Promise<PrivacyZipDownload> {
  const { blob, contentDisposition } = await apiDownloadBlob(
    `/privacy/export/download?jobId=${encodeURIComponent(jobId)}`,
  );
  return { blob, filename: parseAttachmentFilename(contentDisposition) };
}

/** 解析 Content-Disposition 的 filename*=UTF-8''...（缺省/异常 → null）。测试可直接断言。 */
export function parseAttachmentFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const match = contentDisposition.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/i);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1].trim());
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** POST /api/v1/privacy/deactivate {email,password,confirm} → 200 {jobId,status,result?}。 */
export function deactivate(input: PrivacyDeactivateInput): Promise<PrivacyDeactivateResult> {
  return apiRequest<PrivacyDeactivateResult>('/privacy/deactivate', { method: 'POST', body: input });
}
