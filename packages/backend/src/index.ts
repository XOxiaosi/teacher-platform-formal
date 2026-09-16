import express, { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { err, internalError } from '@teacher-platform/contracts';
import { createHealthRouter } from './app/routes/health.routes.js';
import { createAuthRouter } from './app/routes/auth.routes.js';
import { createCoreRouter } from './app/routes/core.routes.js';
import { createCoreRouteDependencies } from './app/composition/core-route-dependencies.js';
import type { CoreRouteDependencies } from './app/composition/types.js';
import { resolveLocalSafeMode } from './app/composition/local-safe-mode.js';
import {
  createWechatFeature,
  parseWechatIlinkEnv,
  type WechatFeature,
} from './app/composition/wechat-assembly.js';
import {
  createDatabaseRouter,
  DatabaseRouterError,
  isDatabaseMissingError,
} from './app/middleware/database-router.js';
import { createRequireAuth, type AuthenticatedRequest } from './app/middleware/require-auth.js';
import { runAsTeacher } from './shared/ai-client/index.js';
import type { AgentConverseUseCase } from './app/use-cases/agent-converse/index.js';
import { createAuthService, type AuthService } from './features/auth/index.js';
import type { PrivacyRouterOptions } from './app/routes/privacy.routes.js';
import {
  createAdminAuthServiceFromEnv,
  createAdminRouter,
  type AdminAuthService,
} from './features/admin/index.js';
import {
  createActionTokenSigner,
  type ActionTokenSigner,
} from './features/pending-action/index.js';
import { createChangelogService, withChangelog } from './shared/changelog/index.js';
import { createDatabaseTrustedClock } from './shared/trusted-clock/index.js';
import {
  createDatabaseClientPool,
  parseDatabasePoolEnv,
  type DatabaseClientPool,
} from './shared/database-pool/index.js';
import {
  createSlidingWindowLimiter,
  createRateLimitMiddleware,
  createAgentTeacherRateLimitMiddleware,
  type RateLimiter,
} from './app/middleware/rate-limit.js';
import { createLogger, type Logger } from './shared/logger/index.js';
import {
  createRequestIdMiddleware,
  createRequestLogMiddleware,
} from './app/middleware/request-id.js';
import {
  registerGracefulShutdown,
  parseShutdownTimeoutMs,
} from './shared/shutdown/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const basePrisma = new PrismaClient();
const changelogService = createChangelogService(basePrisma);
const prisma = withChangelog(basePrisma, changelogService) as unknown as PrismaClient;

/** 全局结构化日志（LOG_LEVEL env 控制级别，T8b 设计 §5.1）。 */
const appLogger: Logger = createLogger();

/** S3 装配：连接池（env 映射读取 MAX_DB_CLIENTS/DB_IDLE_TTL_MS，S1 产物）+ databaseRouter。
 *  默认不挂载（未配置 dbRouter 时行为与现状完全一致，180/1719 基线不动）；
 *  生产启动 / 显式注入时启用。 */
function createDefaultDbRouter(): { pool: DatabaseClientPool; router: ReturnType<typeof createDatabaseRouter> } {
  const pool: DatabaseClientPool = createDatabaseClientPool({
    baseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/teacher_platform',
    ...parseDatabasePoolEnv(),
  });
  const router = createDatabaseRouter({
    registryPrisma: prisma,
    pool,
    registryCacheTtlMs: parseDatabasePoolEnv().registryCacheTtlMs,
  });
  return { pool, router };
}

const defaultDb = createDefaultDbRouter();

/** P1 /metrics 挂载点：JSON 指标对象（聚合逻辑由 backend4 t41 提供，接口契约见下）。 */
function createMetricsRouter(): Router {
  const router = Router();
  // GET /api/v1/metrics → 200 { ok: true, data: { totals, latency, ... } }
  // 契约（与 backend4 t41 对齐）：data 为 JSON 指标对象（MetricsSnapshot 形状，
  // 设计 t38 §3.1：totals/byStatusClass/latency/errorRate5xx）。
  // G3 收口（t3 契约，reports/security/g2-g3-nginx-headers-metrics-fix-contract.md §3）：
  // 池规模（poolSize/dbConnections）等运维指标改走本地 metrics-aggregate 聚合文件，
  // HTTP 端点不暴露（消除平台规模信息泄露）；本端点保留占位聚合，t41 扩展聚合逻辑。
  router.get('/metrics', (_req, res) => {
    res.status(200).json({
      ok: true,
      data: {
        totals: { requests: 0, byStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } },
        latency: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
        errorRate5xx: 0,
      },
    });
  });
  return router;
}

export interface CreateAppOptions {
  agentConverse?: AgentConverseUseCase;
  /** 测试/本地合成注入完整核心依赖；生产缺省走正式组合装配。 */
  coreDependencies?: CoreRouteDependencies;
  rawPrisma?: PrismaClient;
  actionTokenSigner?: ActionTokenSigner;
  authService?: AuthService;
  /** 测试注入自定义 logger（缺省用全局 appLogger）。 */
  logger?: Logger;
  /** 测试注入 databaseRouter（缺省 null=不挂载，保持单库行为；传入实例启用路由） */
  dbRouter?: ReturnType<typeof createDatabaseRouter> | null;
  /** 测试注入连接池（缺省与 dbRouter 配套的全局 pool） */
  dbPool?: DatabaseClientPool;
  /** 测试注入限流器（缺省 createApp 内部新建独立实例） */
  rateLimiter?: RateLimiter;
  /** 测试注入限流中间件（缺省按 env 构建）；null 禁用限流 */
  rateLimitMiddleware?: ReturnType<typeof createRateLimitMiddleware> | null;
  /** P16 双键隔离：per-teacher agent 限流中间件（缺省用内部 limiter 构建，挂 coreGuard 内 requireAuth 后）；null 禁用 */
  agentTeacherRateLimit?: ReturnType<typeof createAgentTeacherRateLimitMiddleware> | null;
  /** A装配（t78）：后台管理认证服务——测试注入；缺省 env（ADMIN_EMAIL/ADMIN_PASSWORD_HASH）就绪时启用，否则 admin 路由不挂载 */
  adminAuthService?: AdminAuthService;
  /** P8 隐私自助化（t29）：导出/注销 API 路由选项（测试注入；缺省用 app 级 logger/limiter + client registry） */
  privacy?: PrivacyRouterOptions;
  /** P8 t20：wechat 特性装配后的运行时句柄回调（优雅退出钩子注册/测试用）。 */
  onWechatRuntime?: (runtime: WechatFeature['runtime']) => void;
  /** L0 本地安全模式：默认开启；只有显式 false（或 LOCAL_SAFE_MODE=false）才关闭。 */
  localSafeMode?: boolean;
  /** 仅 legacy 测试/兼容调用显式开启支付编辑；正式路由默认关闭。 */
  legacyPaymentEditEnabled?: boolean;
}

function unavailableActionTokenSigner(): ActionTokenSigner {
  return {
    sign() {
      return err(internalError('actionToken 服务端密钥未配置'));
    },
    verify() {
      return err(internalError('actionToken 服务端密钥未配置'));
    },
  };
}

function resolveActionTokenSigner(options?: CreateAppOptions): ActionTokenSigner {
  if (options?.actionTokenSigner) return options.actionTokenSigner;
  if (process.env.ACTION_TOKEN_SECRET) {
    return createActionTokenSigner({ secret: process.env.ACTION_TOKEN_SECRET });
  }
  return unavailableActionTokenSigner();
}

export function createApp(client: PrismaClient = prisma, options?: CreateAppOptions) {
  const app = express();
  const editRawPrisma = options?.rawPrisma ?? (client === prisma ? basePrisma : undefined);
  const confirmationPrisma = options?.rawPrisma ?? (client === prisma ? basePrisma : client);
  const logger = options?.logger ?? appLogger;
  const localSafeMode = resolveLocalSafeMode(options?.localSafeMode);
  const router = options?.dbRouter ?? null;
  const pool = options?.dbPool ?? defaultDb.pool;
  // 限流器：每次 createApp 独立实例（避免跨 app 共享计数污染测试；生产单 app 实例语义不变）
  const limiter = options?.rateLimiter ?? createSlidingWindowLimiter({
    maxKeys: Number(process.env.RATE_LIMIT_MAX_KEYS ?? 100_000),
    sweepIntervalMs: 60_000,
  });
  const rateLimit = options?.rateLimitMiddleware === undefined
    ? createRateLimitMiddleware({
      limiter,
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000),
      max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    })
    : options.rateLimitMiddleware;
  // P16 双键隔离（teacher 侧）：per-teacher agent 限流——挂在 coreGuard 内 requireAuth 之后，
  // 键 agent-teacher:${teacherId}（1min/10，env 可覆盖），与前置 rateLimit 的 agent-ip 兜底键窗口隔离。
  const agentTeacherRateLimit = options?.agentTeacherRateLimit === undefined
    ? createAgentTeacherRateLimitMiddleware({ limiter })
    : options.agentTeacherRateLimit;
  const authService = options?.authService ?? createAuthService({
    prisma: client,
    clock: createDatabaseTrustedClock(client),
  });
  // P8 t20：预构建核心依赖（wechat 等共享同一组合——conversation/agent 单实例，budget/工具注册不重复）；
  // 与两个分支传入 createCoreRouter 的选项一致（dbRouter/dbPool 不参与依赖构建）
  const coreDeps = options?.coreDependencies ?? createCoreRouteDependencies(client, {
    agentConverse: options?.agentConverse,
    rawPrisma: editRawPrisma,
    confirmation: {
      rawPrisma: confirmationPrisma,
      actionTokenSigner: resolveActionTokenSigner(options),
    },
    // P14 D 切片：moderation flag 等审计日志复用 app 级 logger（测试可注入捕获）
    logger,
    localSafeMode,
  });
  // A装配（t78）：后台管理认证仅在显式退出 local-safe 后启用。即使宿主环境已有
  // ADMIN_*，安全模式也不读取或装配后台路由，避免旧 .env 改变本机安全启动图。
  const adminAuthService = localSafeMode
    ? undefined
    : (options?.adminAuthService
      ?? (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH
        ? createAdminAuthServiceFromEnv()
        : undefined));
  // P1 trust proxy（t38 §1.4）：只信任同机 nginx（loopback），禁 true——外部伪造 X-Forwarded-* 无效。
  // req.ip 因此取真实客户端 IP（限流 IP 键依赖它）。
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(createRequestIdMiddleware());
  app.use(createRequestLogMiddleware(logger));
  app.use('/api/v1', createHealthRouter({
    registryPrisma: client,
    pool,
    logger,
  }));
  app.use('/api/v1', createAuthRouter(authService, { loginLimiter: limiter, registerLimiter: limiter }));
  // P1 限流：日志中间件之后（被限流请求留痕 status=429）、业务路由组之前；health 放行，
  // metrics 参与限流（G3 收口：t3 契约 §3.2 改动 B——/metrics 落入通用 IP 限流窗口）。
  if (rateLimit) {
    app.use('/api/v1', rateLimit);
  }
  // G3 收口（t3 契约 §3.2 改动 B）：/metrics 挂载移到 rateLimit 之后（参与限流、轮询吞吐
  // 封顶）、admin 路由之前（仍属 /api/v1 公开运维端点，不进 admin 域）。
  app.use('/api/v1', createMetricsRouter());
  // A装配（t78）：/api/v1/admin 子路由——独立 adminToken 鉴权（不经教师 requireAuth/coreGuard），
  // 在 rateLimit 之后（admin 登录走限流 IP 键）；adminAuthService 未启用时不挂载
  if (adminAuthService) {
    app.use('/api/v1/admin', createAdminRouter({
      authService: adminAuthService,
      loginLimiter: limiter,
      registryPrisma: client,
      pool,
      logger,
    }));
  }
  // P8 t20：WeChat iLink 装配——WECHAT_ILINK_ENABLED=true 时挂载（缺关键 env 启动红线在
  // parseWechatIlinkEnv，同 ADMIN 风格）；未启用不挂载（零破坏）；路由公开（webhook/qrcode
  // 不经 requireAuth/coreGuard）；pool 仅 dbRouter 形态传入（单库形态 runInTeacherContext 透传）
  let wechatFeature: WechatFeature | null = null;
  if (!localSafeMode && process.env.WECHAT_ILINK_ENABLED === 'true') {
    const wechatConfig = parseWechatIlinkEnv(process.env);
    wechatFeature = createWechatFeature({
      config: wechatConfig,
      prisma: client,
      authService,
      coreDeps,
      pool: router ? pool : undefined,
      logger,
    });
    app.use('/api/v1', wechatFeature.loginRouter);
    app.use('/api/v1', wechatFeature.messageRouter);
    wechatFeature.runtime.start();
    options?.onWechatRuntime?.(wechatFeature.runtime);
  }
  if (router) {
    // S3：启用数据库路由时，业务路由组前置 requireAuth（设计 §1.3：requireAuth 在前保证
    // teacherId 可信，databaseRouter 紧随其后）。非生产 x-teacher-id dev fallback 使现有
    // 业务测试基线不受影响；生产身份只能来自 session cookie。
    const coreGuard = Router();
    coreGuard.use(createRequireAuth(authService));
    // P16 双键隔离（teacher 侧）：requireAuth 后 per-teacher agent 限流（agent-teacher:${teacherId}，
    // 1min/10）——已认证教师按 teacherId 公平计数，同 IP 多教师互不挤占；未登录 401 到不了此处
    if (agentTeacherRateLimit) {
      coreGuard.use(agentTeacherRateLimit);
    }
    // L4 装配（t77）：请求级教师身份注入 AsyncLocalStorage——routing AiClient 按 teacherId 解析
    // ProviderConfig（无配置/无上下文 → 空串 → 回退默认 provider，与现状行为一致）
    coreGuard.use((req, _res, next) => {
      runAsTeacher((req as AuthenticatedRequest).teacherId ?? '', next);
    });
    coreGuard.use(createCoreRouter(client, {
      dependencies: coreDeps,
      agentConverse: options?.agentConverse,
      authService,
      privacy: options?.privacy ?? {
        authService,
        registryPrisma: client,
        logger,
        limiter,
        spawnCwd: process.cwd(),
      },
      rawPrisma: editRawPrisma,
      confirmation: {
        rawPrisma: confirmationPrisma,
        actionTokenSigner: resolveActionTokenSigner(options),
      },
      dbRouter: router,
      dbPool: pool,
      legacyPaymentEditEnabled: options?.legacyPaymentEditEnabled === true,
    }));
    // S3：DatabaseRouterError → 明确 HTTP 语义（设计 §2.3）：
    //   TEACHER_NOT_FOUND → 404；DATABASE_NOT_READY → 503「教师数据库未就绪」；其余 → 500。
    // 业务查询阶段抛出的 Prisma P1003（库不存在，databaseRouter 只建 client 不建连，
    // 首个查询才失败）同样归一为 503「未就绪」——设计 §2.3「首个查询失败时判断库存在性」。
    coreGuard.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (error instanceof DatabaseRouterError) {
        if (error.code === 'TEACHER_NOT_FOUND') {
          res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: error.message } });
          return;
        }
        if (error.code === 'DATABASE_NOT_READY') {
          res.status(503).json({ ok: false, error: { code: 'DATABASE_NOT_READY', message: error.message } });
          return;
        }
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
        return;
      }
      if (isDatabaseMissingError(error)) {
        res.status(503).json({ ok: false, error: { code: 'DATABASE_NOT_READY', message: '教师数据库未就绪' } });
        return;
      }
      next(error);
    });
    app.use('/api/v1', coreGuard);
  } else {
    // P0 IDOR 修复（qa3 t11 实测）：单库模式（无 dbRouter，dev/测试形态）同样前置
    // requireAuth——身份唯一来源 = session（req.teacherId），x-teacher-id 仅作非生产
    // 无 cookie 时的 dev fallback 注入。与 dbRouter 分支一致，消除业务路由对 header 的
    // 直读依赖面（getTeacherId 已下线 header，见 api-helpers.ts）。
    const coreGuard = Router();
    coreGuard.use(createRequireAuth(authService));
    // P16 双键隔离（teacher 侧）：与 dbRouter 分支一致，requireAuth 后 per-teacher agent 限流
    if (agentTeacherRateLimit) {
      coreGuard.use(agentTeacherRateLimit);
    }
    coreGuard.use(createCoreRouter(client, {
      dependencies: coreDeps,
      agentConverse: options?.agentConverse,
      authService,
      privacy: options?.privacy ?? {
        authService,
        registryPrisma: client,
        logger,
        limiter,
        spawnCwd: process.cwd(),
      },
      rawPrisma: editRawPrisma,
      confirmation: {
        rawPrisma: confirmationPrisma,
        actionTokenSigner: resolveActionTokenSigner(options),
      },
      legacyPaymentEditEnabled: options?.legacyPaymentEditEnabled === true,
    }));
    app.use('/api/v1', coreGuard);
  }
  return app;
}

// P1 修复（t35）：生产入口显式注入 databaseRouter —— 使 node dist/index.js（PM2/Docker 生产入口）
// 默认启用数据库路由（qa3 实测：无参 createApp() 时 dbRouter=null 不挂载，业务请求全落共享库）。
// 设计 §3.4 目标形态：dbRouter 默认启用；测试仍可 createApp(prisma)（不传 dbRouter → 单库兼容，基线不动）。
/** P8 t20：wechat 运行时句柄（优雅退出钩子用；未启用为 null）。 */
let wechatRuntime: WechatFeature['runtime'] | null = null;
const app = createApp(undefined, {
  dbRouter: defaultDb.router,
  dbPool: defaultDb.pool,
  onWechatRuntime: (runtime) => {
    wechatRuntime = runtime;
  },
});

if (require.main === module) {
  if (!process.env.ACTION_TOKEN_SECRET) {
    throw new Error('ACTION_TOKEN_SECRET is required to start the server');
  }
  // listen 回环收紧（T8b 设计 §2.3）：仅绑定本机回环，由 nginx 反代暴露；LISTEN_HOST env 可覆盖。
  const server = app.listen(PORT, process.env.LISTEN_HOST ?? '127.0.0.1');

  // 优雅退出统一入口（T8b 设计 §4.1）：SIGTERM/SIGINT → server.close（停新请求/在途排空）
  // → 连接池 closeAll（S1 幂等）→ 共享库 $disconnect → exit 0；钩子抛错/超时 → exit 1。
  // 池内部自注册的 exit/SIGINT/SIGTERM 钩子作二级兜底（与显式 closeAll 幂等共存）。
  const graceful = registerGracefulShutdown({
    server,
    pool: defaultDb.pool,
    timeoutMs: parseShutdownTimeoutMs(process.env.SHUTDOWN_TIMEOUT_MS),
    logger: appLogger,
    // P8 t20：wechat 队列/恢复扫描生命周期纳入优雅退出（stop 幂等；未启用时无钩子）
    additionalHooks: [
      () => basePrisma.$disconnect(),
      ...(wechatRuntime ? [() => wechatRuntime!.stop()] : []),
    ],
  });

  // 测试/调试开关（T8b 设计 §6.1）：SHUTDOWN_PROBE_MS>0 定时触发优雅退出（跨平台进程级验证）；
  // SHUTDOWN_HANG=1 注入永不 resolve 的钩子（超时兜底 exit 1 路径）。生产不设置即无副作用。
  if (process.env.SHUTDOWN_HANG === '1') {
    graceful.coordinator.register(() => new Promise<void>(() => undefined));
  }
  const probeMs = Number(process.env.SHUTDOWN_PROBE_MS ?? 0);
  if (Number.isFinite(probeMs) && probeMs > 0) {
    const probeTimer = setTimeout(() => {
      void graceful.shutdown('probe');
    }, probeMs);
    probeTimer.unref?.();
  }
}

export default app;
