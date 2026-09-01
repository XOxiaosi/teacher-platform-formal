import { Router } from 'express';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { notFound, permissionDenied, validationError, type CommonError } from '@teacher-platform/contracts';
import type { AdminAuthService } from './admin-auth-service.js';
import { createRequireAdmin, parseAdminToken, type AdminRequest } from '../../shared/http-admin-auth/index.js';
import {
  createLoginLockoutMiddleware,
  recordLoginResult,
  type LoginLockoutConfig,
} from '../../shared/login-lockout/index.js';
import type { RateLimiter } from '../../shared/rate-limit/index.js';
import { findTeacherListItem, getTeacherOverview, listTeachers, type OverviewError } from './teacher-overview.js';
import { getInteractionStats } from './interactions.js';
import { getAdminHealth, defaultBackupRoot } from './admin-health.js';
import { createTeacher, isSafeRestoreTarget, resolveLatestDumpForDatabase, setTeacherStatus } from './admin-actions.js';
import { createAdminJobStore, runSpawnJob } from './admin-jobs.js';
import { recordAdminActionDb, type AdminAuditInput } from './audit.js';
import { getFeedbackSummary } from './feedback-summary.js';
import { getAdminUsageSummary } from './admin-usage-summary.js';
import {
  getFeedbackBoardDetail,
  listFeedbackBoard,
  updateFeedbackBoard,
  feedbackActionForChanges,
  type UpdateFeedbackBoardChanges,
} from './feedback-board.js';
import type { DatabaseClientPool } from '../../shared/database-pool/index.js';
import type { Logger } from '../../shared/logger/index.js';

/**
 * 后台管理路由（P7 渠道线 A2/A3/A4/A5）。
 *
 * 设计依据：reports/architecture/p7-admin-panel-design.md §3.2/§6/§2.1/§2.2/§2.3/§4/§5
 * + QA5（t84 验收）四项：restore 目标复用 ops assertSafeRestoreDatabaseName 语义（镜像+跨通道测试锁定）、
 * 契约错误码（jobId 不存在 404 / 缺 confirm 400 / 轮询终态 {status,result?,error?}）、阶段一审计=结构化日志
 * 扩展字段、写/备份/恢复类动作后端强制 ?confirm=1（前端弹窗由 A5fe，后端校验不可省）。
 * - 独立前缀 /api/v1/admin/*，独立 cookie adminToken（与教师 sessionToken 完全分离）
 * - 登录走 P1 登录锁定（createLoginLockoutMiddleware：主键含 IP 维度 login:ip:email + email 全局键，
 *   R7 gate 纪律）；5 次失败 → 429 + Retry-After + RATE_LIMITED
 * - 生产强制 Secure（与教师 cookie 同属性集，独立名字）
 * - 教师总览：GET /teachers（共享库分页，禁 N×M）+ GET /teachers/:id（详情 + 懒加载聚合，
 *   5s 超时 degraded；库未就绪 503 DATABASE_NOT_READY 与 db-routing 语义一致）
 * - 管理动作：POST /teachers（可选 ?provision=1 → db-provision 后台任务）、PATCH /teachers/:id/status
 *   （软停用/启用）、POST /backup（?confirm=1 + 后台任务 + /backup/status 轮询）、POST /restore
 *   （演练目标 + ?confirm=1 + 后台任务）
 * - A6：动作审计除结构化日志外追加 AdminAuditLog 表落库（旁路，失败不阻断）；反馈看板
 *   GET /feedback/summary（UserRequirement 共享库聚合，只读）
 */

const ADMIN_COOKIE_NAME = 'adminToken';

/** 生产强制 Secure（与 auth.routes.ts 同规则：dev http 不加，本机可用）。 */
function secureAttribute(): string {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

function setAdminCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/api/v1/admin${secureAttribute()}`,
  );
}

function clearAdminCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/api/v1/admin; Max-Age=0${secureAttribute()}`,
  );
}

function statusFromAdminError(error: CommonError): number {
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'ALREADY_CONSUMED' || error.code === 'VERSION_CONFLICT') return 409;
  return 500;
}

function sendAdminError(res: Response, error: CommonError): void {
  res.status(statusFromAdminError(error)).json({ ok: false, error });
}

function readStringBody(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export interface AdminRouterOptions {
  authService: AdminAuthService;
  /** 登录失败锁定限流器（P1 复用）；缺省不启用锁定 */
  loginLimiter?: RateLimiter;
  /** 锁定配置（测试可注入小阈值；缺省读 env LOGIN_FAIL_LIMIT/LOGIN_LOCKOUT_MS/LOGIN_EMAIL_GLOBAL_LIMIT） */
  loginLockoutConfig?: LoginLockoutConfig;
  /** 共享库 client（TeacherRegistry 读 + 健康检查 $queryRaw，教师总览/看板 + A6 审计表/反馈聚合 + 平台用量） */
  registryPrisma: Pick<PrismaClient, 'teacherRegistry' | '$queryRaw' | 'adminAuditLog' | 'userRequirement' | 'providerUsage'>;
  /** 教师库连接池（详情懒加载聚合；列表不触达） */
  pool: DatabaseClientPool;
  /** 单库聚合超时（ms），默认 5000 */
  aggregationTimeoutMs?: number;
  /** 结构化日志（审计：admin action 事件；缺省静默） */
  logger?: Logger;
  /** 备份根目录（测试注入；缺省 env BACKUP_ROOT > 平台默认） */
  backupRoot?: string;
}

/** 库未就绪 503（与 db-routing 语义一致：DATABASE_NOT_READY）。 */
function sendDbNotReady(res: Response, error: OverviewError): void {
  res.status(503).json({ ok: false, error });
}

/** OverviewError 统一出口：DATABASE_NOT_READY → 503；其余走通用信封。 */
function sendOverviewError(res: Response, error: OverviewError): void {
  if (error.code === 'DATABASE_NOT_READY') {
    sendDbNotReady(res, error);
    return;
  }
  sendAdminError(res, error);
}

export function createAdminRouter(options: AdminRouterOptions): Router {
  const router = Router();
  const requireAdmin = createRequireAdmin(options.authService);
  const loginLockout = options.loginLimiter
    ? createLoginLockoutMiddleware({
        limiter: options.loginLimiter,
        ...(options.loginLockoutConfig ? { config: options.loginLockoutConfig } : {}),
      })
    : null;
  const logger = options.logger;
  const backupRoot = options.backupRoot ?? defaultBackupRoot();
  const jobs = createAdminJobStore();
  const spawnCwd = process.cwd(); // 运行于 monorepo 树内（npm -w 自动上溯到仓库根）

  /**
   * A6 审计旁路：结构化日志 + AdminAuditLog 表落库（await 但失败吞掉，不阻断主动作）。
   * IP 取自 Express req.ip；动作成功/失败统一走这里（失败 action 追加 .failed）。
   */
  const audit = async (req: AdminRequest, input: AdminAuditInput): Promise<void> => {
    await recordAdminActionDb(options.registryPrisma, logger, { ...input, ip: req.ip });
  };

  // POST /api/v1/admin/auth/login → 200 + Set-Cookie adminToken（5 次失败锁定 15 分钟，键含 IP 维度）
  router.post('/auth/login', loginLockout ?? ((_req, _res, next) => next()), async (req, res) => {
    const email = readStringBody(req.body, 'email');
    const password = readStringBody(req.body, 'password');
    if (email === undefined || password === undefined) {
      sendAdminError(res, validationError('请求体必须包含 email/password', 'body'));
      return;
    }
    const result = await options.authService.login({ email, password });
    if (!result.ok) {
      const locked = recordLoginResult(res, false);
      if (locked.locked) {
        const retryAfterSeconds = Math.max(1, Math.ceil(locked.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
          ok: false,
          error: { code: 'RATE_LIMITED', message: '多次失败已锁定，请稍后重试', field: 'rate' },
        });
        return;
      }
      sendAdminError(res, result.error);
      return;
    }
    recordLoginResult(res, true);
    setAdminCookie(res, result.value.token);
    res.status(200).json({ ok: true, data: { email: result.value.email } });
  });

  // POST /api/v1/admin/auth/logout → 清 cookie + 删 session，幂等 200
  router.post('/auth/logout', async (req, res) => {
    const token = parseAdminToken(req.headers.cookie);
    if (token) {
      await options.authService.logout(token);
    }
    clearAdminCookie(res);
    res.status(200).json({ ok: true, data: { ok: true } });
  });

  // GET /api/v1/admin/auth/me → 200 {email}（不含任何敏感字段）| 401
  router.get('/auth/me', requireAdmin, async (req: AdminRequest, res) => {
    if (!req.admin) {
      sendAdminError(res, permissionDenied('缺少管理员身份'));
      return;
    }
    const result = await options.authService.getMe(req.admin.email);
    if (!result.ok) {
      sendAdminError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/teachers → 共享库分页列表（不含 passwordHash；禁 N×M 聚合）
  router.get('/teachers', requireAdmin, async (req, res) => {
    const result = await listTeachers(options.registryPrisma, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    });
    if (!result.ok) {
      sendAdminError(res, result.error);
      return;
    }
    // 与教师端列表一致：{items, total}（分页参数在请求侧）
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/teachers/:id → 详情 + 懒加载聚合（5s 超时 degraded；库未就绪 503）
  router.get('/teachers/:id', requireAdmin, async (req, res) => {
    const result = await getTeacherOverview(options.registryPrisma, options.pool, {
      teacherId: String(req.params.id),
      timeoutMs: options.aggregationTimeoutMs,
    });
    if (!result.ok) {
      if (result.error.code === 'DATABASE_NOT_READY') {
        sendDbNotReady(res, result.error);
        return;
      }
      sendAdminError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/interactions?teacherId=&from=&to= → AgentExecution 统计（单教师库，5s 超时 degraded）
  router.get('/interactions', requireAdmin, async (req, res) => {
    const teacherId = typeof req.query.teacherId === 'string' ? req.query.teacherId : undefined;
    if (!teacherId || teacherId.trim() === '') {
      sendAdminError(res, validationError('缺少 teacherId', 'teacherId'));
      return;
    }
    const result = await getInteractionStats(options.registryPrisma, options.pool, {
      teacherId,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
      timeoutMs: options.aggregationTimeoutMs,
    });
    if (!result.ok) {
      if (result.error.code === 'DATABASE_NOT_READY') {
        sendDbNotReady(res, result.error);
        return;
      }
      sendAdminError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/usage/summary?from=&to=&teacherId= → 平台级用量总览（共享库跨教师聚合，只读不记审计）
  router.get('/usage/summary', requireAdmin, async (req, res) => {
    const result = await getAdminUsageSummary(options.registryPrisma, {
      from: req.query.from,
      to: req.query.to,
      teacherId: typeof req.query.teacherId === 'string' ? req.query.teacherId : undefined,
    });
    if (!result.ok) {
      sendOverviewError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/health → 系统健康聚合（ready + 教师库巡检 + 备份 + 迁移 + metrics）
  router.get('/health', requireAdmin, async (_req, res) => {
    const snapshot = await getAdminHealth(options.registryPrisma, options.pool);
    res.status(200).json({ ok: true, data: snapshot });
  });

  // GET /api/v1/admin/feedback/summary?limit= → 反馈看板聚合（UserRequirement 共享库，只读）
  router.get('/feedback/summary', requireAdmin, async (req, res) => {
    const limit = typeof req.query.limit === 'string' && req.query.limit !== ''
      ? Number(req.query.limit)
      : undefined;
    const result = await getFeedbackSummary(options.registryPrisma, { limit });
    if (!result.ok) {
      if (result.error.code === 'DATABASE_NOT_READY') {
        sendDbNotReady(res, result.error);
        return;
      }
      sendAdminError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/feedback?page=&pageSize=&status=&category=&priority= → 看板列表
  // （分页 + 三过滤；admin 全量可见，无 owner 隔离；orderBy occurredAtTs 降序）
  router.get('/feedback', requireAdmin, async (req, res) => {
    const result = await listFeedbackBoard(options.registryPrisma, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : undefined,
      category: typeof req.query.category === 'string' && req.query.category !== '' ? req.query.category : undefined,
      priority: typeof req.query.priority === 'string' && req.query.priority !== '' ? req.query.priority : undefined,
    });
    if (!result.ok) {
      sendOverviewError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/admin/feedback/:id → 看板详情（全字段；404 防探测）
  router.get('/feedback/:id', requireAdmin, async (req, res) => {
    const result = await getFeedbackBoardDetail(options.registryPrisma, String(req.params.id));
    if (!result.ok) {
      sendOverviewError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // PATCH /api/v1/admin/feedback/:id → 管理动作：评估/排期/关联（updateRequirement 状态流转）
  // 请求体 {expectedUpdatedAt, changes:{status?,priority?,category?,linkedDesignDoc?,linkedTaskId?,linkedCommitSha?,...}}
  // 乐观锁 expectedUpdatedAt（复用 edit 模式）；写路径审计 feedback.*（triage/schedule/complete/link/...）
  router.patch('/feedback/:id', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    const requirementId = String(req.params.id);
    const expectedUpdatedAt = readStringBody(req.body, 'expectedUpdatedAt');
    const rawChanges = (req.body as Record<string, unknown> | null | undefined)?.changes;
    if (expectedUpdatedAt === undefined || typeof rawChanges !== 'object' || rawChanges === null || Array.isArray(rawChanges)) {
      await audit(req, {
        actor,
        action: 'feedback.update',
        objectType: 'feedback',
        objectId: requirementId,
        error: validationError('请求体必须包含 expectedUpdatedAt 和 changes 对象', 'body'),
      });
      sendAdminError(res, validationError('请求体必须包含 expectedUpdatedAt 和 changes 对象', 'body'));
      return;
    }
    // 只透传白名单字段（verbatimQuote 天然不可改：changes 不含该键）
    const changes: UpdateFeedbackBoardChanges = {};
    const allowed = new Set([
      'sourceType', 'contextSummary', 'parsedIntent', 'category', 'priority',
      'status', 'linkedDesignDoc', 'linkedTaskId', 'linkedCommitSha',
    ]);
    for (const [key, value] of Object.entries(rawChanges as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        await audit(req, {
          actor,
          action: 'feedback.update',
          objectType: 'feedback',
          objectId: requirementId,
          error: validationError(`changes 不支持字段 ${key}`, 'changes'),
        });
        sendAdminError(res, validationError(`changes 不支持字段 ${key}`, 'changes'));
        return;
      }
      if (typeof value === 'string') {
        (changes as Record<string, string>)[key] = value;
      }
    }
    if (Object.keys(changes).length === 0) {
      await audit(req, {
        actor,
        action: 'feedback.update',
        objectType: 'feedback',
        objectId: requirementId,
        error: validationError('changes 不能为空', 'changes'),
      });
      sendAdminError(res, validationError('changes 不能为空', 'changes'));
      return;
    }

    const result = await updateFeedbackBoard(options.registryPrisma, { requirementId, expectedUpdatedAt, changes });
    if (!result.ok) {
      await audit(req, {
        actor,
        action: feedbackActionForChanges(changes),
        objectType: 'feedback',
        objectId: requirementId,
        error: result.error,
      });
      sendOverviewError(res, result.error);
      return;
    }
    await audit(req, {
      actor,
      action: feedbackActionForChanges(changes),
      objectType: 'feedback',
      objectId: requirementId,
      detail: { changes },
    });
    res.status(200).json({ ok: true, data: result.value });
  });

  // ---- 管理动作（A5；全部 requireAdmin + 审计；写/备份/恢复类后端强制 ?confirm=1）----

  // POST /api/v1/admin/teachers → 创建教师（email 唯一 + scrypt；可选 ?provision=1 → db-provision 后台任务）
  router.post('/teachers', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    const email = readStringBody(req.body, 'email');
    const password = readStringBody(req.body, 'password');
    const displayName = readStringBody(req.body, 'displayName');
    if (email === undefined || password === undefined || displayName === undefined) {
      await audit(req, { actor, action: 'teacher.create', objectType: 'teacher', error: validationError('缺少字段', 'body') });
      sendAdminError(res, validationError('请求体必须包含 email/password/displayName', 'body'));
      return;
    }
    const provision = req.query.provision === '1';
    // provision 时生成 teacher_db_* 安全库名（ops assertSafeTeacherDatabaseName 白名单形态），
    // db-provision 后台建库 + migrate deploy
    const provisionDbName = provision ? `teacher_db_${randomBytes(4).toString('hex')}` : undefined;
    const result = await createTeacher(options.registryPrisma, {
      email,
      password,
      displayName,
      databaseName: provisionDbName,
    });
    if (!result.ok) {
      await audit(req, { actor, action: 'teacher.create', objectType: 'teacher', error: result.error });
      sendAdminError(res, result.error);
      return;
    }
    await audit(req, { actor, action: 'teacher.create', objectType: 'teacher', objectId: result.value.id });
    if (provision && provisionDbName) {
      const jobId = jobs.create('provision');
      void runSpawnJob(jobs, jobId, {
        command: 'npm',
        args: ['-w', '@teacher-platform/ops', 'run', 'db-provision', '--', '--database-name', provisionDbName],
        cwd: spawnCwd,
      });
      res.status(201).json({ ok: true, data: { teacher: result.value, job: { jobId } } });
      return;
    }
    res.status(201).json({ ok: true, data: { teacher: result.value } });
  });

  // PATCH /api/v1/admin/teachers/:id/status → 软停用/启用（仅 status 翻转；停用后登录 401 由 auth-service 锁定）
  router.patch('/teachers/:id/status', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    const status = readStringBody(req.body, 'status');
    if (status !== 'active' && status !== 'disabled') {
      await audit(req, { actor, action: 'teacher.status', objectType: 'teacher', objectId: String(req.params.id), error: validationError('status 只能是 active|disabled', 'status') });
      sendAdminError(res, validationError('status 只能是 active|disabled', 'status'));
      return;
    }
    const result = await setTeacherStatus(options.registryPrisma, String(req.params.id), status);
    if (!result.ok) {
      await audit(req, { actor, action: status === 'disabled' ? 'teacher.disable' : 'teacher.enable', objectType: 'teacher', objectId: String(req.params.id), error: result.error });
      sendAdminError(res, result.error);
      return;
    }
    await audit(req, {
      actor,
      action: status === 'disabled' ? 'teacher.disable' : 'teacher.enable',
      objectType: 'teacher',
      objectId: result.value.id,
    });
    res.status(200).json({ ok: true, data: { teacher: result.value } });
  });

  // POST /api/v1/admin/backup?confirm=1 → 后台 db-backup（全量或按教师）；/backup/status?jobId= 轮询
  router.post('/backup', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    if (req.query.confirm !== '1') {
      await audit(req, { actor, action: 'backup.run', objectType: 'backup', error: validationError('缺少确认', 'confirm') });
      sendAdminError(res, validationError('备份操作需要 confirm=1 确认', 'confirm'));
      return;
    }
    const teacherId = readStringBody(req.body, 'teacherId');
    if (teacherId !== undefined) {
      const teacher = await findTeacherListItem(options.registryPrisma, teacherId);
      if (!teacher.ok) {
        await audit(req, { actor, action: 'backup.run', objectType: 'backup', objectId: teacherId, error: teacher.error });
        sendOverviewError(res, teacher.error);
        return;
      }
    }
    const jobId = jobs.create('backup');
    void runSpawnJob(jobs, jobId, {
      command: 'npm',
      args: ['-w', '@teacher-platform/ops', 'run', 'db-backup', '--', '--root', backupRoot],
      cwd: spawnCwd,
      env: { BACKUP_ROOT: backupRoot },
    });
    await audit(req, { actor, action: 'backup.run', objectType: 'backup', objectId: teacherId, detail: { jobId } });
    res.status(202).json({ ok: true, data: { jobId } });
  });

  // GET /api/v1/admin/backup/status?jobId= → 轮询终态 {status, result?, error?}；jobId 不存在 → 404（QA5 契约）
  router.get('/backup/status', requireAdmin, async (req, res) => {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    if (!jobId || jobId.trim() === '') {
      sendAdminError(res, validationError('缺少 jobId', 'jobId'));
      return;
    }
    const job = jobs.get(jobId);
    if (!job) {
      sendAdminError(res, notFound('任务不存在'));
      return;
    }
    res.status(200).json({
      ok: true,
      data: { jobId: job.jobId, status: job.status, ...(job.result !== undefined ? { result: job.result } : {}), ...(job.error !== undefined ? { error: job.error } : {}) },
    });
  });

  // POST /api/v1/admin/restore?confirm=1 → 演练恢复（目标必须匹配 teacher_db_*_restore_* / teacher_platform_restore_*）
  router.post('/restore', requireAdmin, async (req: AdminRequest, res) => {
    const actor = req.admin?.email ?? 'unknown';
    if (req.query.confirm !== '1') {
      await audit(req, { actor, action: 'restore.run', objectType: 'backup', error: validationError('缺少确认', 'confirm') });
      sendAdminError(res, validationError('演练恢复需要 confirm=1 确认', 'confirm'));
      return;
    }
    const teacherId = readStringBody(req.body, 'teacherId');
    const target = readStringBody(req.body, 'target');
    if (teacherId === undefined || target === undefined) {
      await audit(req, { actor, action: 'restore.run', objectType: 'backup', error: validationError('缺少字段', 'body') });
      sendAdminError(res, validationError('请求体必须包含 teacherId/target', 'body'));
      return;
    }
    // QA5 要求 1：目标校验镜像 ops assertSafeRestoreDatabaseName（双形态正则；跨通道一致性由单测锁定）
    if (!isSafeRestoreTarget(target)) {
      await audit(req, { actor, action: 'restore.run', objectType: 'backup', objectId: teacherId, error: validationError('目标不合法', 'target') });
      sendAdminError(res, validationError('演练目标必须匹配 teacher_db_*_restore_* 或 teacher_platform_restore_*', 'target'));
      return;
    }
    const teacher = await findTeacherListItem(options.registryPrisma, teacherId);
    if (!teacher.ok) {
      await audit(req, { actor, action: 'restore.run', objectType: 'backup', objectId: teacherId, error: teacher.error });
      sendOverviewError(res, teacher.error);
      return;
    }
    const dumpFile = await resolveLatestDumpForDatabase(backupRoot, teacher.value.databaseName);
    if (!dumpFile) {
      await audit(req, { actor, action: 'restore.run', objectType: 'backup', objectId: teacherId, error: validationError('无备份', 'backup') });
      sendAdminError(res, validationError('未找到该教师的备份 dump，请先执行备份', 'backup'));
      return;
    }
    const jobId = jobs.create('restore');
    void runSpawnJob(jobs, jobId, {
      command: 'npm',
      args: ['-w', '@teacher-platform/ops', 'run', 'db-restore', '--', '--database', teacher.value.databaseName, '--from', dumpFile, '--target', target],
      cwd: spawnCwd,
      env: { BACKUP_ROOT: backupRoot },
    });
    await audit(req, { actor, action: 'restore.run', objectType: 'backup', objectId: teacherId, detail: { jobId, target } });
    res.status(202).json({ ok: true, data: { jobId } });
  });

  return router;
}
