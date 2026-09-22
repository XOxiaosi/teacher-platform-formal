import type { NextFunction, Request, Response } from 'express';
import { rateLimited } from '@teacher-platform/contracts';
import type { AuthenticatedRequest } from './require-auth.js';

/**
 * API 限流中间件：自研内存滑动窗口（零依赖）。
 *
 * 设计依据：reports/architecture/p7-p1-hardening-design.md §2
 * - 键策略（P16 双键隔离）：普通端点认证请求按 teacherId、未认证按 IP（req.ip，依赖
 *   trust proxy 'loopback' 取真实客户端 IP）；Agent 端点独立双键——前置按独立 IP 兜底键
 *   `agent-ip:`（1min/10，与普通请求窗口隔离），coreGuard 内（requireAuth 后）按
 *   `agent-teacher:${teacherId}`（1min/10，同 IP 多教师互不挤占）。未登录请求到不了
 *   agent 处理器（requireAuth 401），agent 成本天然只被已认证请求消耗。
 * - 普通端点默认 10 分钟 / 600 次（env RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS 可覆盖）
 * - Agent 端点更严：1 分钟 / 10 次（env AGENT_RATE_LIMIT_MAX / AGENT_RATE_LIMIT_WINDOW_MS 可覆盖）
 * - 登录失败锁定：5 次失败 → 锁定 15 分钟（env LOGIN_FAIL_LIMIT / LOGIN_LOCKOUT_MS），成功清零
 * - 响应 429 + Retry-After + 错误信封 {ok:false,error:{code:'RATE_LIMITED'}}
 * - 多进程迁移路径：接口保持 RateLimiter 形状，实现换 Redis 计数（设计 §2.1）
 *
 * 时间语义：限流是单调时钟语义（窗口比较），用 performance.now()（D47/D48 纪律：
 * 业务时间走 TrustedClock，限流簿记不属业务时间，avoid Date.now 边界扫描）。
 */

export interface RateLimitRule {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
}

export interface RateLimiter {
  check(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  recordFailure(key: string, options?: { failLimit?: number; lockoutMs?: number }): { locked: boolean; retryAfterMs: number };
  recordSuccess(key: string): void;
  isLocked(key: string): { locked: boolean; retryAfterMs: number };
  /** 键数上限防护：超过 maxKeys 不再新建键（防内存耗尽型攻击） */
  size(): number;
  sweep(): void;
}

export interface CreateRateLimiterOptions {
  maxKeys?: number;
  sweepIntervalMs?: number;
}

interface LoginLockState {
  failCount: number;
  lockedUntil: number;
}

/**
 * 创建内存滑动窗口限流器。
 * - 滑动窗口：Map<key, number[]> 时间戳数组；check 时剪除窗口外时间戳，超 max 拒绝
 * - 登录锁定：Map<key, LoginLockState>，5 次失败锁 15 分钟
 * - sweep：定时剪除过期时间戳与失效锁定（与 database-pool 巡检同风格，unref）
 */
export function createSlidingWindowLimiter(options: CreateRateLimiterOptions = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? 100_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  const windows = new Map<string, number[]>();
  const locks = new Map<string, LoginLockState>();

  function pruneWindow(key: string, windowMs: number, now: number): number[] {
    const timestamps = windows.get(key) ?? [];
    const cutoff = now - windowMs;
    const kept = timestamps.filter((ts) => ts > cutoff);
    if (kept.length === 0) {
      windows.delete(key);
    } else {
      windows.set(key, kept);
    }
    return kept;
  }

  function sweepNow(): void {
    const now = performance.now();
    for (const [key, timestamps] of windows) {
      const kept = timestamps.filter((ts) => ts > now - 24 * 60 * 60 * 1000);
      if (kept.length === 0) windows.delete(key);
      else windows.set(key, kept);
    }
    for (const [key, state] of locks) {
      if (state.lockedUntil > 0 && state.lockedUntil <= now) locks.delete(key);
    }
  }

  // 巡检定时器（与 database-pool 同风格：unref 不阻塞进程退出；单测可手动调 sweep）
  const sweepTimer = setInterval(sweepNow, sweepIntervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  return {
    async check(key, windowMs, max) {
      const now = performance.now();
      const kept = pruneWindow(key, windowMs, now);
      if (kept.length >= max) {
        const oldest = kept[0] ?? now;
        return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
      }
      if (!windows.has(key)) {
        if (windows.size >= maxKeys) {
          // 键数上限：拒绝新建键（视为放行但记 warn——上限是防内存耗尽，不误伤真实请求）
          return { allowed: true, retryAfterMs: 0 };
        }
      }
      windows.set(key, [...kept, now]);
      return { allowed: true, retryAfterMs: 0 };
    },

    recordFailure(key, options) {
      const now = performance.now();
      const current = locks.get(key);
      if (current && current.lockedUntil > now) {
        return { locked: true, retryAfterMs: current.lockedUntil - now };
      }
      const failLimit = options?.failLimit ?? 5;
      const lockoutMs = options?.lockoutMs ?? 15 * 60 * 1000;
      const failCount = (current?.failCount ?? 0) + 1;
      if (failCount >= failLimit) {
        const lockedUntil = now + lockoutMs;
        locks.set(key, { failCount, lockedUntil });
        return { locked: true, retryAfterMs: lockoutMs };
      }
      locks.set(key, { failCount, lockedUntil: 0 });
      return { locked: false, retryAfterMs: 0 };
    },

    recordSuccess(key) {
      locks.delete(key);
    },

    isLocked(key) {
      const current = locks.get(key);
      if (!current) return { locked: false, retryAfterMs: 0 };
      const now = performance.now();
      // lockedUntil=0 表示「失败计数未达锁定阈值」——非锁定态，不清除失败计数（否则计数永远被 isLocked 清空）
      if (current.lockedUntil === 0) return { locked: false, retryAfterMs: 0 };
      if (current.lockedUntil <= now) {
        locks.delete(key);
        return { locked: false, retryAfterMs: 0 };
      }
      return { locked: true, retryAfterMs: current.lockedUntil - now };
    },

    size() {
      return windows.size + locks.size;
    },

    sweep() {
      sweepNow();
    },
  };
}

// ---- 中间件工厂 ----

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** 普通端点窗口（ms），默认 10 分钟 */
  windowMs?: number;
  /** 普通端点上限，默认 600 */
  max?: number;
  /** Agent 端点窗口（ms）；缺省读 env AGENT_RATE_LIMIT_WINDOW_MS，再缺省 1 分钟 */
  agentWindowMs?: number;
  /** Agent 端点上限；缺省读 env AGENT_RATE_LIMIT_MAX，再缺省 10 */
  agentMax?: number;
  /** 不参与限流的路径前缀（health 放行；metrics 参与限流，G3 收口） */
  skipPrefixes?: string[];
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 600;
const AGENT_WINDOW_MS = 60 * 1000;
const AGENT_MAX = 10;

/** Agent 端点窗口/上限 env 解析（P16：AGENT_RATE_LIMIT_MAX/WINDOW_MS 此前仅注释声明未实现，本次落地）。 */
function resolveAgentWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.AGENT_RATE_LIMIT_WINDOW_MS, AGENT_WINDOW_MS);
}

function resolveAgentMax(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.AGENT_RATE_LIMIT_MAX, AGENT_MAX);
}

/** 判定是否为 Agent 类昂贵端点（AI 调用，更严限流）。 */
const AGENT_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/agent\/converse/,
  /^\/ai\/raw-input/,
  /^\/daily-review\/assemble/,
  /^\/feedback\/generate-draft/,
  /\/capture-from-text/,
];

/** 解析请求 IP（与 requestKey 共用逻辑）；无法解析返回 null。 */
function resolveRequestIp(req: Request): string | null {
  let ip: string;
  try {
    ip = req.ip ?? '';
  } catch {
    return null;
  }
  if (!ip || ip === 'unknown') return null;
  return ip;
}

function requestKey(req: Request): string | null {
  const authenticated = req as AuthenticatedRequest;
  if (authenticated.teacherId) return `teacher:${authenticated.teacherId}`;
  // req.ip 是 Express getter，依赖 req.socket.remoteAddress（自建 mock 请求可能无 socket）
  // 无法解析 IP 时返回 null → 跳过限流（视为内部/测试请求；生产环境 req.ip 恒可用）
  const ip = resolveRequestIp(req);
  if (ip === null) return null;
  return `ip:${ip}`;
}

/**
 * Agent 路径独立 IP 兜底键（P16 双键隔离）：
 * - 前置 rateLimit（requireAuth 之前，拿不到 teacherId）对 agent 路径一律按 `agent-ip:${ip}`
 *   计数（1min/10），与普通请求的 `ip:` 键窗口**隔离**——普通请求不再耗尽 agent 额度、
 *   同 IP 多教师仍受 IP 级聚合兜底（防多账号同 IP 刷 AI 成本）；
 * - per-teacher 公平额度（`agent-teacher:${teacherId}`）由 coreGuard 内
 *   createAgentTeacherRateLimitMiddleware（requireAuth 之后）负责，二者互不共享窗口。
 */
function agentIpKey(req: Request): string | null {
  const ip = resolveRequestIp(req);
  if (ip === null) return null;
  return `agent-ip:${ip}`;
}

function isAgentPath(pathname: string): boolean {
  return AGENT_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function sendRateLimited(res: Response, retryAfterMs: number, message: string): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({ ok: false, error: rateLimited(message) });
}

/**
 * 创建通用限流中间件（挂载在业务路由组之前；health 放行；metrics 参与限流）。
 * 普通端点 10min/600；Agent 端点 1min/10。
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX;
  const agentWindowMs = options.agentWindowMs ?? resolveAgentWindowMs();
  const agentMax = options.agentMax ?? resolveAgentMax();
  const skipPrefixes = options.skipPrefixes ?? ['/health'];

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const pathname = req.path;
    if (skipPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      next();
      return;
    }
    const isAgent = isAgentPath(pathname);
    // agent 路径走独立 IP 兜底键（agent-ip:），普通路径走 teacherId/IP 键（互不共享窗口）
    const key = isAgent ? agentIpKey(req) : requestKey(req);
    if (key === null) {
      // 无法解析键（无 teacherId 且无有效 IP）：跳过限流（内部/测试请求容错）
      next();
      return;
    }
    const ruleWindow = isAgent ? agentWindowMs : windowMs;
    const ruleMax = isAgent ? agentMax : max;
    const result = await options.limiter.check(key, ruleWindow, ruleMax);
    if (!result.allowed) {
      sendRateLimited(res, result.retryAfterMs, '请求过于频繁，请稍后重试');
      return;
    }
    next();
  };
}

/** per-teacher agent 限流中间件选项（挂载在 requireAuth 之后；窗口/上限缺省读 env 再回退默认）。 */
export interface AgentTeacherRateLimitOptions {
  limiter: RateLimiter;
  /** 窗口（ms）；缺省 AGENT_RATE_LIMIT_WINDOW_MS，再缺省 1 分钟 */
  windowMs?: number;
  /** 上限；缺省 AGENT_RATE_LIMIT_MAX，再缺省 10 */
  max?: number;
}

/**
 * per-teacher agent 限流中间件（P16 双键隔离的 teacher 侧）：
 * 键 `agent-teacher:${teacherId}`，1min/10——已认证教师按 teacherId 公平计数，
 * 同 IP 多教师互不挤占；未认证请求（无 teacherId）由前置 requireAuth 401 拦截，
 * 到不了本中间件（防御性放行兜底）。与前置 rateLimit 的 agent-ip 键窗口隔离。
 */
export function createAgentTeacherRateLimitMiddleware(options: AgentTeacherRateLimitOptions) {
  const windowMs = options.windowMs ?? resolveAgentWindowMs();
  const max = options.max ?? resolveAgentMax();

  return async function agentTeacherRateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!isAgentPath(req.path)) {
      next();
      return;
    }
    const teacherId = (req as AuthenticatedRequest).teacherId;
    if (!teacherId) {
      // requireAuth 已在前保证 teacherId；此处防御性放行（不重复计数）
      next();
      return;
    }
    const result = await options.limiter.check(`agent-teacher:${teacherId}`, windowMs, max);
    if (!result.allowed) {
      sendRateLimited(res, result.retryAfterMs, '请求过于频繁，请稍后重试');
      return;
    }
    next();
  };
}

/** 登录失败锁定配置（env 可覆盖：LOGIN_FAIL_LIMIT / LOGIN_LOCKOUT_MS / LOGIN_EMAIL_GLOBAL_LIMIT）。 */
export interface LoginLockoutConfig {
  /** 同 IP+email 组合失败锁定阈值，默认 5 */
  failLimit: number;
  /** 锁定窗口（ms），默认 15 分钟 */
  lockoutMs: number;
  /** email 维度全局失败累计阈值（防跨 IP 撞库，锁全 email），默认 20；0 禁用 */
  emailGlobalLimit: number;
}

export function parseLoginLockoutEnv(env: NodeJS.ProcessEnv = process.env): LoginLockoutConfig {
  return {
    failLimit: parsePositiveIntEnv(env.LOGIN_FAIL_LIMIT, 5),
    lockoutMs: parsePositiveIntEnv(env.LOGIN_LOCKOUT_MS, 15 * 60 * 1000),
    emailGlobalLimit: parsePositiveIntEnv(env.LOGIN_EMAIL_GLOBAL_LIMIT, 20),
  };
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * 登录失败锁定中间件（挂载在 /auth/login 路由内）。
 *
 * 键策略（P1 t45，设计 §2.3）：
 * - 主键 `login:${ip}:${email}`——同 IP 同 email 5 次失败锁 15 分钟；
 *   含 IP 维度避免「攻击者故意输错 5 次锁死他人邮箱」的登录 DoS。
 * - email 全局键 `login:global:${email}`——跨 IP 失败累计超阈值（默认 20 次）锁全 email，
 *   防分布式撞库；阈值 env LOGIN_EMAIL_GLOBAL_LIMIT 可配（0 禁用）。
 * - 无 IP（mock/内部请求）回退纯 email 键 `login:${email}`。
 */
export function createLoginLockoutMiddleware(options: {
  limiter: RateLimiter;
  config?: LoginLockoutConfig;
  /** 自定义主键（默认 ip:email）；测试可注入 */
  key?: (req: Request, email: string) => string;
}) {
  const config = options.config ?? parseLoginLockoutEnv();

  function buildKeys(req: Request, email: string): { primary: string; global: string | null } {
    const normalized = email.trim().toLowerCase();
    const custom = options.key;
    if (custom) return { primary: custom(req, email), global: null };
    const ip = resolveRequestIp(req);
    const primary = ip === null ? `login:${normalized}` : `login:${ip}:${normalized}`;
    const global = config.emailGlobalLimit > 0 ? `login:global:${normalized}` : null;
    return { primary, global };
  }

  return function loginLockoutMiddleware(req: Request, res: Response, next: NextFunction): void {
    const body = (req.body ?? {}) as { email?: unknown };
    if (typeof body.email !== 'string') {
      next();
      return;
    }
    const { primary, global } = buildKeys(req, body.email);

    // 先查 email 全局锁（跨 IP 撞库已触发），再查主键锁
    if (global) {
      const globalLocked = options.limiter.isLocked(global);
      if (globalLocked.locked) {
        sendRateLimited(res, globalLocked.retryAfterMs, '多次失败已锁定，请稍后重试');
        return;
      }
    }
    const primaryLocked = options.limiter.isLocked(primary);
    if (primaryLocked.locked) {
      sendRateLimited(res, primaryLocked.retryAfterMs, '多次失败已锁定，请稍后重试');
      return;
    }

    // 在 res.locals 暂存锁键与限流器/配置，登录路由成功/失败时经 recordLoginResult 消费
    (res.locals as Record<string, unknown>).loginLockKeys = { primary, global };
    (res.locals as Record<string, unknown>).loginLimiter = options.limiter;
    (res.locals as Record<string, unknown>).loginLockoutConfig = config;
    next();
  };
}

/** 登录结果消费：成功清零；失败计数（达阈值锁定）。在 /auth/login 路由内调用。 */
export function recordLoginResult(
  res: Response,
  success: boolean,
): { locked: boolean; retryAfterMs: number } {
  const keys = (res.locals as Record<string, unknown>).loginLockKeys as
    | { primary: string; global: string | null }
    | undefined;
  const limiter = (res.locals as Record<string, unknown>).loginLimiter as RateLimiter | undefined;
  const config = (res.locals as Record<string, unknown>).loginLockoutConfig as
    | LoginLockoutConfig
    | undefined;
  if (!keys || !limiter) return { locked: false, retryAfterMs: 0 };

  if (success) {
    // 成功登录：清零主键与 email 全局累计（误锁恢复）
    limiter.recordSuccess(keys.primary);
    if (keys.global) limiter.recordSuccess(keys.global);
    return { locked: false, retryAfterMs: 0 };
  }

  const failLimit = config?.failLimit ?? 5;
  const lockoutMs = config?.lockoutMs ?? 15 * 60 * 1000;

  // 失败：email 全局累计（跨 IP 撞库防护；达 emailGlobalLimit 锁全 email）
  if (keys.global && config && config.emailGlobalLimit > 0) {
    const globalResult = limiter.recordFailure(keys.global, {
      failLimit: config.emailGlobalLimit,
      lockoutMs,
    });
    if (globalResult.locked) {
      return { locked: true, retryAfterMs: globalResult.retryAfterMs };
    }
  }
  // 主键计数（同 IP+email 达 failLimit 锁 lockoutMs）
  return limiter.recordFailure(keys.primary, { failLimit, lockoutMs });
}

// ---- 邀请接受限流（沿用旧配置名，按 IP 滑动窗口封顶探测吞吐）----

/** 邀请接受限流配置（env 名为兼容旧部署保持不变）。 */
export interface RegisterRateLimitConfig {
  /** 每 IP 每窗口最大邀请接受尝试次数，默认 20 */
  max: number;
  /** 邀请接受限流窗口（ms），默认 1 小时 */
  windowMs: number;
}

export function parseRegisterRateLimitEnv(env: NodeJS.ProcessEnv = process.env): RegisterRateLimitConfig {
  return {
    max: parsePositiveIntEnv(env.REGISTER_RATE_LIMIT_MAX, 20),
    windowMs: parsePositiveIntEnv(env.REGISTER_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
  };
}

/**
 * 邀请接受限流中间件（挂载在 POST /auth/invitations/accept handler 之前）。
 *
 * 设计依据：reports/security/register-rate-limit-fix-contract.md（t2/t3 双线交叉印证冻结）
 * - 键 `register:ip:${ip}`（复用 resolveRequestIp；IP 无法解析 → next() 跳过，与 requestKey 同语义）；
 * - `limiter.check(key, windowMs, max)` 不通过 → 429 + Retry-After + 统一限流错误
 *   （与 login 锁定同信封：RATE_LIMITED + field:'rate'）；
 * - 在 handler 之前运行 → 成功/失败（含校验失败）请求一律计数（封顶邮箱枚举探测吞吐）；
 * - 键前缀 `register:ip:` 与 login 锁定键 `login:*` 天然隔离（共享同一 limiter 实例无互相污染）；
 * - 时间簿记用 performance.now()（R1 纪律，与既有限流一致；限流是单调时钟语义）。
 */
export function createRegisterRateLimitMiddleware(options: {
  limiter: RateLimiter;
  config?: RegisterRateLimitConfig; // 缺省 parseRegisterRateLimitEnv()
  key?: (req: Request) => string;   // 测试注入；缺省 register:ip:${ip}
}): (req: Request, res: Response, next: NextFunction) => void {
  const config = options.config ?? parseRegisterRateLimitEnv();

  return async function registerRateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    let key: string | null;
    if (options.key) {
      key = options.key(req);
    } else {
      const ip = resolveRequestIp(req);
      key = ip === null ? null : `register:ip:${ip}`;
    }
    if (key === null) {
      // 无法解析键（无有效 IP）：跳过限流（内部/测试请求容错；生产 req.ip 恒可用）
      next();
      return;
    }
    const result = await options.limiter.check(key, config.windowMs, config.max);
    if (!result.allowed) {
      sendRateLimited(res, result.retryAfterMs, '邀请接受请求过于频繁，请稍后重试');
      return;
    }
    next();
  };
}
