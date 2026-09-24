import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../shared/logger/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { runWithRequestDb, type DatabaseClientPool } from '../../shared/database-pool/index.js';
import { runAsTeacher } from '../../shared/ai-client/index.js';
import type { AuthService } from '../../features/auth/index.js';
import {
  createChannelConversationService,
  createChannelIdentityService,
  createChannelMessageService,
  createIlinkContextStore,
  createIlinkHttpClient,
  createIlinkLongPollDriver,
  createIlinkOutboundAdapter,
  createInboundMessageService,
  createInMemoryMessageQueue,
  createLoginStateStore,
  createUnavailableCodeExchanger,
  createWechatAgentLoop,
  createWechatConversationResolver,
  createWechatLoginRouter,
  createWechatMessageRouter,
  createWechatOutboundSender,
  createWechatUnboundRecoveryScanner,
  parseWechatIlinkEnv,
  type NormalizedInboundMessage,
  type WechatIlinkConfig,
} from '../../features/wechat/index.js';
import { createWechatTeachingTaskAgent } from '../teaching-runtime/wechat-teaching-task-agent.js';
import type { CoreRouteDependencies } from './types.js';

/**
 * WeChat iLink 装配工厂（P8 t20 装配 + P9 W0 真实 transport，设计 p7-wechat-ilink-design.md §12）。
 *
 * - 由 index.ts（装配线独占）在 WECHAT_ILINK_ENABLED=true 时调用；未启用不创建（零破坏，同 admin 先例）；
 * - 复用 core-route-dependencies 的 teaching-task service + DSH worker（渠道不再拥有另一套 Agent loop）；
 * - runInTeacherContext：worker 在 HTTP 请求外运行——pool.acquire(教师库) + runWithRequestDb 建立
 *   请求级数据库上下文（conversation/agent-execution/tool 的 getClient 由此路由到教师库）；单库形态透传；
 * - W0 真实 transport（协议冻结 p9-w0-wechat-ilink-protocol-freeze.md）：
 *   - 出站 sendmessage：ilinkHttpClient（config.apiBaseUrl/botToken 凭证）+ contextStore（回复前置
 *     context_token）→ createIlinkOutboundAdapter（Result 信封，错误码对齐 CommonError）；
 *   - 入站长轮询：createIlinkLongPollDriver（getupdates 40s + 退避 + session 过期终止）→ start 时
 *     投递归一化消息给 inboundService.receiveWebhook（claim 持久幂等 + 入队，复用 webhook 同款流水线）；
 *   - 凭证纪律：bot_token 只来自 config（env WECHAT_ILINK_BOT_TOKEN / S1 扫码），不落仓库/测试；
 * - 生命周期：runtime.start() 启动队列 worker + 未绑定恢复扫描 + 长轮询 driver；stop() 供优雅退出钩子。
 */

export interface CreateWechatFeatureOptions {
  config: WechatIlinkConfig;
  prisma: PrismaClient;
  authService: AuthService;
  coreDeps: CoreRouteDependencies;
  /** 教师库连接池（生产 dbRouter 形态；单库形态不传 → runInTeacherContext 透传） */
  pool?: DatabaseClientPool;
  logger?: Logger;
}

export interface WechatFeature {
  loginRouter: Router;
  messageRouter: Router;
  runtime: {
    start(): void;
    stop(): Promise<void>;
  };
}

const TEACHER_DB_CACHE_TTL_MS = 60_000;

/**
 * worker 在请求外运行：解析教师库名（TTL 缓存）→ pool.acquire → 教师库上下文（runWithRequestDb）
 * + 教师身份上下文（runAsTeacher，provider 路由必需——routing-ai-client currentTeacherId 读它）。
 * 与 HTTP coreGuard 顺序一致（requireAuth → runAsTeacher → dbRouter/runWithRequestDb，双 ALS 并存）。
 * P1 修复（qa3 t26）：原实现缺 runAsTeacher → wechat worker currentTeacherId 恒 '' → provider 回退默认，
 * 教师自定义 ProviderConfig 失效（ARK 无 key 时 agent 必失败）。
 */
export function createRunInTeacherContext(pool: DatabaseClientPool, prisma: PrismaClient) {
  const cache = new Map<string, { dbName: string; expiresAt: number }>();
  return async function runInTeacherContext<T>(teacherId: string, fn: () => Promise<T>): Promise<T> {
    const now = performance.now();
    const cached = cache.get(teacherId);
    let dbName = cached && cached.expiresAt > now ? cached.dbName : undefined;
    if (!dbName) {
      const teacher = await prisma.teacherRegistry.findUnique({
        where: { id: teacherId },
        select: { databaseName: true },
      });
      if (!teacher) {
        throw new Error(`教师记录不存在: ${teacherId}`);
      }
      dbName = teacher.databaseName;
      cache.set(teacherId, { dbName, expiresAt: now + TEACHER_DB_CACHE_TTL_MS });
    }
    const client = await pool.acquire(dbName);
    try {
      return await runWithRequestDb({ client, dbName }, () => runAsTeacher(teacherId, () => fn()));
    } finally {
      pool.release(dbName);
    }
  };
}

export function createWechatFeature(options: CreateWechatFeatureOptions): WechatFeature {
  const { config, prisma, authService, coreDeps, pool } = options;
  const logger = options.logger;

  // 共享库服务（ChannelIdentity/ChannelMessage 与 TeacherRegistry/SessionStore 同库）
  const identityService = createChannelIdentityService({ prisma });
  const channelMessageService = createChannelMessageService({ prisma });
  const clock = createDatabaseTrustedClock(prisma);
  const loginStateStore = createLoginStateStore({
    ttlMs: config.stateTtlMs,
    maxKeys: config.maxStateKeys,
  });

  // S3 Agent 闭环：渠道只做身份/队列/收发，规划与工具循环统一进入 teaching-task/DSH。
  const runInTeacherContext = pool
    ? createRunInTeacherContext(pool, prisma)
    // 单库形态：无池（无教师库路由）——仍须 runAsTeacher（provider 路由 currentTeacherId 依赖）
    : (async <T>(teacherId: string, fn: () => Promise<T>): Promise<T> => runAsTeacher(teacherId, () => fn()));
  // S5 多会话：渠道会话映射（共享库）+ 平台 Conversation（教师库，经 coreDeps）
  const channelConversations = createChannelConversationService({ prisma });
  const teachingTasks = coreDeps.teachingTasks;
  if (!teachingTasks) throw new Error('WeChat 功能需要 teaching-task 服务');
  const conversationResolver = createWechatConversationResolver({
    conversationService: teachingTasks,
    channelConversations,
    clock,
    runtimeOwner: 'dsh-v1',
  });
  const teachingTaskAgent = createWechatTeachingTaskAgent({
    tasks: teachingTasks,
    runtimeWorker: coreDeps.teachingRuntimeWorker,
  });
  const agentLoop = createWechatAgentLoop({
    agentConverse: teachingTaskAgent,
    conversationResolver,
    runInTeacherContext,
  });

  // W0 真实 transport（协议冻结 p9-w0）：iLink HTTP client + context store + 出站适配器 + 入站长轮询 driver。
  // 凭证纪律：bot_token 只经 config（env WECHAT_ILINK_BOT_TOKEN / S1 扫码交换）进入 client；测试 mock，不落盘。
  const ilinkClient = createIlinkHttpClient({
    apiBaseUrl: config.apiBaseUrl,
    botToken: config.botToken,
    requestTimeoutMs: config.outboundTimeoutMs,
  });
  const contextStore = createIlinkContextStore({ ttlMs: config.contextTokenTtlMs });
  const adapter = createIlinkOutboundAdapter({ client: ilinkClient, contextStore });
  const driver = createIlinkLongPollDriver({ config, client: ilinkClient, contextStore, logger });
  const outbound = createWechatOutboundSender({
    channelMessageService,
    adapter,
    clock,
    maxTextLength: config.maxTextLength,
  });

  // 队列 + 入站 + 恢复扫描（生命周期由 runtime 管理）
  const queue = createInMemoryMessageQueue({ maxSize: 1000 });
  const inboundService = createInboundMessageService({
    channelMessageService,
    identityService,
    queue,
    clock,
    agentLoop,
    outbound,
  });
  const recoveryScanner = createWechatUnboundRecoveryScanner({
    channelMessageService,
    identityService,
    queue,
    clock,
    intervalMs: config.recoveryIntervalMs,
    maxPendingMs: config.unboundMaxPendingMs,
  });

  const loginRouter = createWechatLoginRouter({
    authService,
    channelIdentityService: identityService,
    stateStore: loginStateStore,
    config,
    codeExchanger: createUnavailableCodeExchanger(),
  });
  const messageRouter = createWechatMessageRouter({
    config,
    inboundService,
  });

  return {
    loginRouter,
    messageRouter,
    runtime: {
      start() {
        queue.start(async (msg) => {
          const result = await inboundService.processMessage(msg);
          if (!result.ok) {
            logger?.error('wechat inbound process failed', { error: result.error, externalMessageId: msg.externalMessageId });
          }
        });
        recoveryScanner.start();
        // W0 入站长轮询：driver 投递已归一化的 NormalizedInboundMessage（parseIlinkInboundMessage 在
        // driver 内完成）→ receiveWebhook（claim 持久幂等 + 入队，与 webhook 入口同流水线）。
        // start 失败（如缺 bot_token fail-closed）只记日志，不影响网页端。
        driver
          .start(async (raw) => {
            const msg = raw as NormalizedInboundMessage;
            const result = await inboundService.receiveWebhook(msg);
            if (!result.ok) {
              logger?.error('wechat ilink inbound receive failed', {
                error: result.error,
                externalMessageId: msg.externalMessageId,
              });
            }
          })
          .then((result) => {
            if (!result.ok) logger?.error('wechat ilink driver start failed', { error: result.error });
          });
        logger?.info('wechat iLink feature started');
      },
      async stop() {
        await driver.stop();
        recoveryScanner.stop();
        await queue.stop();
      },
    },
  };
}

export { parseWechatIlinkEnv };
