import { Router } from 'express';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  internalError,
  notFound,
  rateLimited,
  validationError,
  type CommonError,
} from '@teacher-platform/contracts';
import type { PrismaClient } from '@prisma/client';
import type { AuthService } from '../../features/auth/index.js';
import type { Logger } from '../../shared/logger/index.js';
import { createRequireAuth, type AuthenticatedRequest } from '../middleware/require-auth.js';
import type { RateLimiter } from '../middleware/rate-limit.js';
import { createJobStore, runSpawnJob, type BackgroundJobStore } from '../../shared/background-jobs/index.js';
import { defaultBackupRoot } from '../../features/admin/admin-health.js';

/** 隐私自助导出与注销 API；所有操作均受 session owner 围栏与服务端门禁保护。 */

const SESSION_COOKIE_NAME = 'sessionToken';
const EXPORT_TTL_MS = 60 * 60 * 1000;

/**
 * rm 带短暂重试（P15 t1：一次性产物清理防瞬态失败——Windows 句柄未释放 / 杀软扫描瞬态锁 /
 * 全量负载下磁盘抖动；EPERM/EBUSY 等重试 5 次共约 2.5s，最终失败抛给调用方记审计，TTL sweep 兜底）。
 * 旧实现单次 rm 失败被 .catch 吞掉 → 产物永久残留 → 下载后清理断言偶发红（单跑不触发，负载下偶发）。
 */
async function retryRm(target: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolveRetry) => setTimeout(resolveRetry, 250 + attempt * 250));
    }
  }
  throw lastError;
}

/** 生产强制 Secure（与 auth.routes 同规则）。 */
function secureAttribute(): string {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

/** 清空会话 cookie（注销成功后）。 */
function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttribute()}`,
  );
}

function statusFromError(error: CommonError): number {
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'RATE_LIMITED') return 429;
  return 500;
}

function sendError(res: Response, error: CommonError): void {
  res.status(statusFromError(error)).json({ ok: false, error });
}

function readStringBody(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** 隐私操作审计：结构化日志（actor=teacher；失败 action 追加 .failed）。 */
function recordAudit(logger: Logger | undefined, input: {
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
  error?: unknown;
}): void {
  if (!logger) return;
  const action = input.error !== undefined ? `${input.action}.failed` : input.action;
  logger.info('privacy action', {
    actor: input.actor,
    action,
    ...(input.detail ?? {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

export interface PrivacyRateLimitConfig {
  /** 导出窗口（ms），默认 10 分钟 */
  exportWindowMs: number;
  /** 导出窗口内上限，默认 10 */
  exportMax: number;
  /** 注销窗口（ms），默认 10 分钟 */
  deactivateWindowMs: number;
  /** 注销窗口内上限（高风险更严），默认 3 */
  deactivateMax: number;
}

export interface PrivacyRouterOptions {
  authService: AuthService;
  /** 共享库 client（TeacherRegistry 邮箱匹配 + SessionStore 会话失效；隔离测试注入） */
  registryPrisma: Pick<PrismaClient, 'teacherRegistry' | 'sessionStore'>;
  /** 结构化日志（审计 actor=teacher；缺省静默） */
  logger?: Logger;
  /** 限流器（复用 RateLimiter；缺省不限流） */
  limiter?: RateLimiter;
  /** 限流配置（测试可注入小阈值） */
  rateLimitConfig?: Partial<PrivacyRateLimitConfig>;
  /** 导出产物根目录（测试注入；缺省 env BACKUP_ROOT > 平台默认） */
  exportRoot?: string;
  /** 注销二次确认固定短语（缺省 'DELETE'；confirm=邮箱 也接受） */
  confirmPhrase?: string;
  /** spawn 工作目录（npm -w 上溯 monorepo 根；缺省 process.cwd()） */
  spawnCwd?: string;
  /** 注销 spawn 超时（ms），默认 5 分钟 */
  deactivateTimeoutMs?: number;
}

interface ExportJobMeta {
  teacherId: string;
  dir: string;
  /** 导出产物格式：'json'（缺省，目录 + JSON 附件）| 'zip'（--zip 单包，application/zip 下载） */
  format: 'json' | 'zip' | 'readable';
}

export function createPrivacyRouter(options: PrivacyRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(options.authService);
  const logger = options.logger;
  const exportRoot = options.exportRoot ?? defaultBackupRoot();
  const confirmPhrase = options.confirmPhrase ?? 'DELETE';
  const spawnCwd = options.spawnCwd ?? process.cwd();
  const rateLimitConfig: PrivacyRateLimitConfig = {
    exportWindowMs: options.rateLimitConfig?.exportWindowMs ?? 10 * 60 * 1000,
    exportMax: options.rateLimitConfig?.exportMax ?? 10,
    deactivateWindowMs: options.rateLimitConfig?.deactivateWindowMs ?? 10 * 60 * 1000,
    deactivateMax: options.rateLimitConfig?.deactivateMax ?? 3,
  };

  const jobs: BackgroundJobStore = createJobStore();
  // jobId → 导出产物目录（owner 隔离 + 下载后清理 + TTL sweep）
  const exportDirs = new Map<string, ExportJobMeta>();

  function sweepExportDirs(): void {
    const now = performance.now();
    // 惰性：创建新导出时清理超龄目录（TTL 与 job store 对齐）
    for (const [jobId, meta] of exportDirs) {
      const job = jobs.get(jobId);
      const createdAt = job?.createdAt ?? 0;
      if (now - createdAt > EXPORT_TTL_MS) {
        void rm(meta.dir, { recursive: true, force: true }).catch(() => {});
        if (meta.format === 'zip' || meta.format === 'readable') {
          void rm(`${meta.dir}.zip`, { force: true }).catch(() => {});
        }
        void removeEmptyExportParents(meta.dir);
        exportDirs.delete(jobId);
      }
    }
  }

  /**
   * 导出产物清理后顺带移除空父目录（P12 t4 修复）：jobDir = <exportRoot>/exports/<teacherId>/<jobId>，
   * 向上最多 2 层（exports/<teacherId>、exports/）——仅删除空目录，非空/不存在/权限不足即停（绝不误删）。
   * 注：用 rmdir（fs.rm 无 recursive 对目录返回 EISDIR，Node 26 行为）。
   */
  async function removeEmptyExportParents(jobDir: string): Promise<void> {
    let current = dirname(jobDir); // <exportRoot>/exports/<teacherId>
    for (let depth = 0; depth < 2; depth += 1) {
      try {
        await rmdir(current);
      } catch {
        break; // 非空（ENOTEMPTY）/不存在（ENOENT）/权限 → 停止
      }
      current = dirname(current);
    }
  }

  async function checkRateLimit(
    res: Response,
    teacherId: string,
    kind: 'export' | 'deactivate',
  ): Promise<boolean> {
    if (!options.limiter) return true;
    const config = kind === 'export'
      ? { windowMs: rateLimitConfig.exportWindowMs, max: rateLimitConfig.exportMax }
      : { windowMs: rateLimitConfig.deactivateWindowMs, max: rateLimitConfig.deactivateMax };
    const result = await options.limiter.check(`privacy:${kind}:${teacherId}`, config.windowMs, config.max);
    if (result.allowed) return true;
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    sendError(res, rateLimited('操作过于频繁，请稍后重试'));
    return false;
  }

  // POST /api/v1/privacy/export → 202 {jobId}（owner 隔离：仅导出当前 session 教师）
  // body.format：缺省 'json'（既有契约：download 返回 manifest/account/tables JSON 附件）；
  // 'zip'（P14 t5）→ export-teacher-data --zip 打包单包，download 返回 application/zip。
  router.post('/privacy/export', requireAuth, async (req: AuthenticatedRequest, res) => {
    const teacherId = req.teacherId;
    if (!teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    if (!(await checkRateLimit(res, teacherId, 'export'))) return;

    const requestedFormat = readStringBody(req.body, 'format');
    const format = requestedFormat === 'readable' ? 'readable' : requestedFormat === 'zip' ? 'zip' : 'json';
    const jobId = jobs.create('privacy-export', teacherId);
    const exportDir = resolve(exportRoot, 'exports', teacherId, jobId);
    await mkdir(exportDir, { recursive: true });
    exportDirs.set(jobId, { teacherId, dir: exportDir, format });
    sweepExportDirs();

    void runSpawnJob(jobs, jobId, {
      command: 'npm',
      args: ['-w', '@teacher-platform/ops', 'run', format === 'readable' ? 'export-teacher-readable' : 'export-teacher-data', '--', '--teacher-id', teacherId, '--out', exportDir, ...(format === 'json' ? [] : ['--zip'])],
      cwd: spawnCwd,
    });
    recordAudit(logger, { actor: teacherId, action: 'privacy.export.run', detail: { jobId, format } });
    res.status(202).json({ ok: true, data: { jobId } });
  });

  // GET /api/v1/privacy/export/status?jobId= → 轮询终态（jobId 不存在/他人 → 404，不泄露存在性）
  router.get('/privacy/export/status', requireAuth, async (req: AuthenticatedRequest, res) => {
    const teacherId = req.teacherId;
    if (!teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    if (!jobId || jobId.trim() === '') {
      sendError(res, validationError('缺少 jobId', 'jobId'));
      return;
    }
    const job = jobs.get(jobId);
    if (!job || job.kind !== 'privacy-export' || job.owner !== teacherId) {
      sendError(res, notFound('任务不存在'));
      return;
    }
    res.status(200).json({
      ok: true,
      data: {
        jobId: job.jobId,
        status: job.status,
        ...(job.result !== undefined ? { result: job.result } : {}),
        ...(job.error !== undefined ? { error: job.error } : {}),
      },
    });
  });

  // GET /api/v1/privacy/export/download?jobId= → 认证下载（jobId+owner 校验 + succeeded）；
  // 返回 {manifest, account, tables} JSON 附件，下载后清理导出目录
  router.get('/privacy/export/download', requireAuth, async (req: AuthenticatedRequest, res) => {
    const teacherId = req.teacherId;
    if (!teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    if (!jobId || jobId.trim() === '') {
      sendError(res, validationError('缺少 jobId', 'jobId'));
      return;
    }
    const job = jobs.get(jobId);
    if (!job || job.kind !== 'privacy-export' || job.owner !== teacherId) {
      sendError(res, notFound('任务不存在'));
      return;
    }
    if (job.status !== 'succeeded') {
      sendError(res, validationError(`任务未完成（当前状态 ${job.status}）`, 'jobId'));
      return;
    }
    const meta = exportDirs.get(jobId);
    if (!meta) {
      sendError(res, notFound('导出产物不存在（可能已过期清理）'));
      return;
    }

    // P14 t5：zip 产物 → application/zip 附件下载（export-teacher-data --zip 输出 <dir>.zip，
    // 含 manifest/account/tables/media 单包）；下载后清理目录 + zip（一次性产物）。
    if (meta.format === 'zip' || meta.format === 'readable') {
      const zipPath = `${meta.dir}.zip`;
      try {
        await stat(zipPath);
      } catch {
        sendError(res, notFound('zip 导出产物不存在'));
        return;
      }
      recordAudit(logger, { actor: teacherId, action: 'privacy.export.download', detail: { jobId, format: meta.format } });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`export-${teacherId}.zip`)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      const stream = createReadStream(zipPath);
      // P15 t1：读流 error 必须接住——未捕获 'error' 会崩整个进程（EMFILE/瞬态句柄锁），
      // 全量负载下偶发；记审计，连接由客户端侧断开兜底。
      stream.on('error', (error) => {
        recordAudit(logger, {
          actor: teacherId,
          action: 'privacy.export.download',
          error: `stream: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
      stream.pipe(res);
      try {
        // 等响应完整发送（res finish）后再清理——finished(stream) 只等 readable 消费完，
        // 早于 res flush，下载端可能还没收全就触发清理（P14 t5 实测竞态）。
        await finished(res);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        recordAudit(logger, { actor: teacherId, action: 'privacy.export.download', error: message });
        // 客户端中断/响应异常：不跳过清理（一次性产物仍需移除），继续走下方清理
      }
      // 下载结束（成功或中断）后清理：先确保读流 fd 已释放（Windows 删除打开文件可能 EPERM），
      // 再删目录 + zip（retryRm 防瞬态失败）；最终失败记审计（TTL sweep 兜底）。
      // 注：先注册 close 监听再 destroy（避免 closed 检查与 once 注册之间的竞态窗口）。
      await new Promise<void>((resolveClosed) => {
        if (stream.closed) {
          resolveClosed();
          return;
        }
        stream.once('close', () => resolveClosed());
        stream.destroy();
      });
      try {
        await retryRm(meta.dir, { recursive: true, force: true });
        await retryRm(zipPath, { force: true });
        await removeEmptyExportParents(meta.dir);
      } catch (cleanupError) {
        recordAudit(logger, {
          actor: teacherId,
          action: 'privacy.export.download',
          error: `cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        });
      }
      exportDirs.delete(jobId);
      return;
    }

    try {
      const manifestText = await readFile(resolve(meta.dir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestText) as unknown;
      const accountText = await readFile(resolve(meta.dir, 'account.json'), 'utf8');
      const account = JSON.parse(accountText) as unknown;

      const tablesDir = resolve(meta.dir, 'tables');
      const files = await readdir(tablesDir);
      const tables: Record<string, unknown[]> = {};
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const raw = await readFile(resolve(tablesDir, file), 'utf8');
        tables[file.replace(/\.jsonl$/, '')] = raw
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown);
      }

      // 下载后清理（一次性产物）+ 顺带移除空父目录（exports/<teacherId>、exports/，P12 t4 修复）；
      // P15 t1：retryRm 防瞬态失败（同 zip 分支）
      await retryRm(meta.dir, { recursive: true, force: true });
      await removeEmptyExportParents(meta.dir);
      exportDirs.delete(jobId);

      recordAudit(logger, { actor: teacherId, action: 'privacy.export.download', detail: { jobId } });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`export-${teacherId}.json`)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        ok: true,
        data: { manifest, account, tables, scope: 'records', mediaDelivery: 'manifest_only' },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordAudit(logger, { actor: teacherId, action: 'privacy.export.download', error: message });
      sendError(res, internalError(`读取导出产物失败：${message}`));
    }
  });

  // POST /api/v1/privacy/deactivate → 邮箱+密码双验证 + confirm 二次确认 → 服务端 spawn --confirm → 会话失效
  router.post('/privacy/deactivate', requireAuth, async (req: AuthenticatedRequest, res) => {
    const teacherId = req.teacherId;
    if (!teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    if (!(await checkRateLimit(res, teacherId, 'deactivate'))) return;

    const email = readStringBody(req.body, 'email');
    const password = readStringBody(req.body, 'password');
    const confirm = readStringBody(req.body, 'confirm');
    if (email === undefined || password === undefined || confirm === undefined) {
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error: validationError('缺少字段', 'body') });
      sendError(res, validationError('请求体必须包含 email/password/confirm', 'body'));
      return;
    }

    // 1. 邮箱匹配（owner 隔离：只能注销当前 session 教师的账号）
    let teacher;
    try {
      teacher = await options.registryPrisma.teacherRegistry.findUnique({ where: { id: teacherId } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendError(res, internalError(`读取账号失败：${message}`));
      return;
    }
    if (!teacher) {
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error: notFound('教师不存在') });
      sendError(res, notFound('教师不存在'));
      return;
    }
    if (teacher.email !== email.trim().toLowerCase()) {
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error: validationError('邮箱与当前账号不匹配', 'email') });
      sendError(res, validationError('邮箱与当前账号不匹配', 'email'));
      return;
    }

    // 2. 密码验证（auth-service verifyCredentials，不签发会话；统一错误防枚举）
    const verified = await options.authService.verifyCredentials({ teacherId, email, password });
    if (!verified.ok) {
      const error = verified.error.code === 'PERMISSION_DENIED'
        ? validationError('邮箱或密码错误', 'password')
        : verified.error;
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error });
      sendError(res, error);
      return;
    }

    // 3. 二次确认：confirm=邮箱 或 固定短语（服务端门禁；前端不传裸 confirm）
    const confirmOk = confirm.trim().toLowerCase() === email.trim().toLowerCase()
      || confirm.trim() === confirmPhrase;
    if (!confirmOk) {
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error: validationError('二次确认不匹配', 'confirm') });
      sendError(res, validationError('二次确认不匹配（需输入邮箱或确认短语）', 'confirm'));
      return;
    }

    // 4. 服务端 spawn deactivate-teacher.mjs --confirm（--confirm 只由服务端追加）
    const jobId = jobs.create('privacy-deactivate', teacherId);
    await runSpawnJob(jobs, jobId, {
      command: 'npm',
      args: ['-w', '@teacher-platform/ops', 'run', 'deactivate-teacher', '--', '--teacher-id', teacherId, '--confirm'],
      cwd: spawnCwd,
      env: { BACKUP_ROOT: exportRoot },
      timeoutMs: options.deactivateTimeoutMs,
    });
    const job = jobs.get(jobId);
    if (!job || job.status !== 'succeeded') {
      const message = job?.error ?? '注销任务失败';
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error: message });
      sendError(res, internalError(`注销失败：${message}`));
      return;
    }

    // 5. 会话失效：删该教师全部 SessionStore（脚本已删共享库侧；API 侧同步删除，测试可断言登录 401）
    try {
      await options.registryPrisma.sessionStore.deleteMany({ where: { teacherId } });
      await options.registryPrisma.teacherRegistry.deleteMany({ where: { id: teacherId } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', error: message });
      sendError(res, internalError(`注销后清理失败：${message}`));
      return;
    }
    clearSessionCookie(res);
    recordAudit(logger, { actor: teacherId, action: 'privacy.deactivate', detail: { jobId } });
    res.status(200).json({
      ok: true,
      data: {
        jobId: job.jobId,
        status: job.status,
        ...(job.result !== undefined ? { result: job.result } : {}),
      },
    });
  });

  return router;
}
