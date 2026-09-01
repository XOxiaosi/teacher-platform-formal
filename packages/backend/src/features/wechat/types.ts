import type { CommonError, Result } from '@teacher-platform/contracts';

/** 渠道平台标识：wechat（iLink 个人号）。 */
export const WECHAT_PLATFORM = 'wechat' as const;

/** 扫码登录 state 生命周期（LoginStateStore 持有，性能单调时钟 TTL）。 */
export interface WechatLoginState {
  /** 一次性随机 state（randomBytes(32) base64url）。 */
  state: string;
  /** 发起扫码时的教师（已登录 session）；未登录路径缺省。 */
  teacherId?: string;
  /** code 交换成功后写入的微信侧用户标识（ilink_user_id / wxid）。 */
  externalUserId?: string;
  /** 供应商渠道标识（ilink_bot_id；可空）。 */
  providerChannelId?: string;
  /** pending（等待回调）→ confirmed（未登录，等待 bind）→ bound（已绑定）。 */
  status: 'pending' | 'confirmed' | 'bound';
  /** 过期时刻（performance.now() 单调时钟；不用墙钟/不落库）。 */
  expiresAtMs: number;
}

/** 扫码登录 state 存储（阶段一内存实现；接口形状预留表化迁移）。 */
export interface LoginStateStore {
  /** 新建一次性 state；键数达上限返回 null（防内存耗尽）。 */
  create(input: { teacherId?: string }): string | null;
  /** 读取 state（过期即清除并返回 undefined）。 */
  get(state: string): WechatLoginState | undefined;
  /** pending → confirmed（写入 externalUserId）；非 pending/不存在返回 false。 */
  markConfirmed(state: string, input: { externalUserId: string; providerChannelId?: string }): boolean;
  /** pending|confirmed → bound（绑定完成；防 state 重放消费）。 */
  markBound(state: string): boolean;
  /** 删除（显式失效）。 */
  delete(state: string): void;
  size(): number;
  sweep(): void;
}

/** iLink code 交换结果（服务端到服务端，不经过浏览器）。 */
export interface CodeExchangeResult {
  externalUserId: string;
  providerChannelId?: string;
  botToken?: string;
}

/** code 交换器端口：真实实现依赖 W0 供应商协议冻结；测试注入假实现。 */
export interface CodeExchanger {
  exchange(input: { code: string; state: string }): Promise<Result<CodeExchangeResult, CommonError>>;
}

export interface ChannelIdentityDto {
  id: string;
  teacherId: string;
  platform: string;
  externalUserId: string;
  providerChannelId: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

/** 渠道身份服务：绑定/解绑/按外部用户解析教师（S2 消息渠道复用 resolveTeacherId）。 */
export interface ChannelIdentityService {
  bind(input: {
    teacherId: string;
    platform: string;
    externalUserId: string;
    providerChannelId?: string;
  }): Promise<Result<ChannelIdentityDto, CommonError>>;
  /** 解绑 = 删除绑定行（幂等：无绑定也返回 ok）。 */
  unbind(input: { teacherId: string; platform: string }): Promise<Result<{ unbound: boolean }, CommonError>>;
  /** iLink 身份 → 教师路由：外部用户解析 teacherId（无绑定返回 null）。 */
  resolveTeacherId(input: { platform: string; externalUserId: string }): Promise<Result<string | null, CommonError>>;
  /** 外部用户 → 完整绑定（teacherId + providerChannelId/botId；无绑定返回 null）。S3 clientRequestId 派生用。 */
  resolveChannelBinding(input: {
    platform: string;
    externalUserId: string;
  }): Promise<Result<{ teacherId: string; providerChannelId: string | null } | null, CommonError>>;
  listByTeacher(input: { teacherId: string; platform?: string }): Promise<Result<ChannelIdentityDto[], CommonError>>;
}

/** 平台级 iLink 配置（env 解析产物，见 config.ts）。 */
export interface WechatIlinkConfig {
  enabled: boolean;
  appid: string;
  appSecret: string;
  token: string;
  apiBaseUrl: string;
  /** 回调 IP 白名单（CIDR/单 IP）；空 = fail-closed 全拒。 */
  allowedIps: string[];
  stateTtlMs: number;
  /** 回调 timestamp 窗口（±ms，防重放）。 */
  timestampWindowMs: number;
  qrcodeRatePerMin: number;
  callbackRatePerMin: number;
  bindRatePerMin: number;
  /** 入站消息限流：单用户（fromExternalUserId）每分钟条数，防刷屏。 */
  inboundPerMin: number;
  /** 出站主动推送限流：单教师每分钟条数（S4 notify；默认 60，env WECHAT_ILINK_NOTIFY_PER_MIN）。 */
  notifyRatePerMin: number;
  /** 出站回复分片长度（设计 §8.1 WECHAT_ILINK_MAX_TEXT_LENGTH，默认 1500）。 */
  maxTextLength: number;
  /** 未绑定恢复扫描间隔（ms；默认 5 分钟）。 */
  recoveryIntervalMs: number;
  /** 未绑定消息最长挂起时间（ms；超过置 failed，默认 24h）。 */
  unboundMaxPendingMs: number;
  /** webhook 处理超时（ms；超时 503 背压保护，默认 4000 < 微信 5s 硬约束）。 */
  webhookTimeoutMs: number;
  maxStateKeys: number;
  /** iLink bot token（WECHAT_ILINK_BOT_TOKEN；S1 扫码动态获取为主，预配场景可选——W0 传输层凭证）。 */
  botToken: string;
  /** 长轮询单请求超时（ms；iLink 40s 语义，默认 40000，W0 冻结）。 */
  longPollTimeoutMs: number;
  /** 长轮询连续失败退避序列（ms；对齐 openhanako [2000, 5000, 30000]，W0 冻结）。 */
  pollBackoffMs: number[];
  /** 长轮询连续失败达上限 → driver 状态 error（默认 3，W0 冻结）。 */
  maxConsecutivePollFailures: number;
  /** context_token 缓存 TTL（ms；iLink 回复前置条件，默认 24h，W0 冻结）。 */
  contextTokenTtlMs: number;
  /** 出站 HTTP 请求超时（ms；sendmessage/getupdates 之外的一般请求，默认 15000）。 */
  outboundTimeoutMs: number;
}

// ── S2 入站消息（t13，设计 p7-wechat-ilink-design.md §4）──────────────────────

/** 标准化入站消息（供应商无关；业务层只消费本形状，不感知 webhook/长轮询差异）。 */
export interface NormalizedInboundMessage {
  channel: 'wechat';
  externalMessageId: string;
  fromExternalUserId: string;
  toExternalUserId?: string;
  conversationType: 'private' | 'group';
  messageType: 'text';
  text: string;
  /** provider opaque 上下文，不进模型/工具参数。 */
  replyContext?: unknown;
}

export type ChannelMessageStatus = 'new' | 'queued' | 'processed' | 'failed';

export interface ChannelMessageDto {
  id: string;
  teacherId: string | null;
  channel: string;
  externalMessageId: string;
  fromExternalUserId: string;
  toExternalUserId: string | null;
  direction: string;
  contentType: string;
  contentText: string;
  status: ChannelMessageStatus;
  errorMsg: string | null;
  processedAtTs: Date | null;
  createdAtTs: Date;
}

/** 入站消息持久化服务（共享库 ChannelMessage；@@unique([channel, externalMessageId]) 持久幂等）。 */
export interface ChannelMessageService {
  /** claim：插入 status=new；同 externalMessageId 已存在 → duplicate=true（不重复落行）。 */
  claim(input: {
    channel: string;
    externalMessageId: string;
    fromExternalUserId: string;
    toExternalUserId?: string;
    contentType?: string;
    contentText: string;
  }): Promise<Result<{ row: ChannelMessageDto; duplicate: boolean }, CommonError>>;
  markQueued(id: string): Promise<Result<ChannelMessageDto, CommonError>>;
  /** 未绑定挂起：status 回到 new（不处理，等 S3 恢复扫描）。 */
  markPending(id: string): Promise<Result<ChannelMessageDto, CommonError>>;
  /** 处理完成：status=processed + teacherId + processedAtTs（TrustedClock 时间由调用方传入）。 */
  markProcessed(id: string, input: { teacherId: string; processedAt: Date }): Promise<Result<ChannelMessageDto, CommonError>>;
  /** 处理失败：status=failed + errorMsg（可重试依据；幂等键防重复由 AgentExecution claim 保证）。 */
  markFailed(id: string, input?: { errorMsg?: string }): Promise<Result<ChannelMessageDto, CommonError>>;
  getByExternalMessageId(channel: string, externalMessageId: string): Promise<Result<ChannelMessageDto | null, CommonError>>;
  /** 出站消息落表（direction=outbound；externalMessageId=`out:<correlationId>:<chunkIndex>` 确定性幂等）。 */
  recordOutbound(input: {
    channel: string;
    teacherId: string;
    correlationId: string;
    chunkIndex: number;
    fromExternalUserId: string;
    toExternalUserId: string;
    contentText: string;
    status: 'sent' | 'failed';
    errorMsg?: string;
    processedAt: Date;
  }): Promise<Result<ChannelMessageDto, CommonError>>;
  /** 恢复扫描：status=new 的挂起消息列表（limit 上限）。 */
  listPending(): Promise<Result<ChannelMessageDto[], CommonError>>;
}

/** 消息队列端口（阶段一进程内实现；接口预留 Redis Streams / RabbitMQ 迁移，业务零改动）。 */
export interface QueuePort {
  enqueue(msg: NormalizedInboundMessage): Promise<Result<{ queued: boolean }, CommonError>>;
  start(handler: (msg: NormalizedInboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  size(): number;
}

/** 入站消息服务：webhook 接收（claim+入队）+ worker 处理（身份解析/挂起/Agent 闭环）。 */
export interface InboundMessageService {
  /** webhook 入口：claim（持久幂等）→ 入队；返回 accepted/duplicate（5s 内 200 硬约束，不做重活）。 */
  receiveWebhook(msg: NormalizedInboundMessage): Promise<Result<{ accepted: boolean; duplicate: boolean }, CommonError>>;
  /** 队列 worker 处理：解析 teacherId → 未绑定挂起（status=new）；已绑定 → Agent 闭环 → processed + TrustedClock。 */
  processMessage(msg: NormalizedInboundMessage): Promise<Result<{
    status: 'unbound' | 'processed' | 'already' | 'failed';
  }, CommonError>>;
}

// ── S3 Agent 闭环（t16，设计 p7-wechat-ilink-design.md §5/§10 S3 切片）─────────

/** 渠道会话映射 DTO（共享库 ChannelConversation；t23 S5 多会话）。 */
export interface ChannelConversationDto {
  id: string;
  teacherId: string;
  channel: string;
  externalConversationId: string;
  conversationId: string;
  status: string;
  lastMessageAtTs: Date | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

/** 渠道会话映射服务：外部会话 ↔ 平台 Conversation（一教师多发送方各自独立会话）。 */
export interface ChannelConversationService {
  findMapping(input: {
    channel: string;
    teacherId: string;
    externalConversationId: string;
  }): Promise<Result<ChannelConversationDto | null, CommonError>>;
  recordMapping(input: {
    channel: string;
    teacherId: string;
    externalConversationId: string;
    conversationId: string;
    lastMessageAt?: Date;
  }): Promise<Result<ChannelConversationDto, CommonError>>;
  touchLastMessage(input: { id: string; lastMessageAt: Date }): Promise<Result<ChannelConversationDto, CommonError>>;
}

/** 会话解析：按外部会话（发送方/群 ID）解析平台 Conversation（多会话映射：查映射 → 复用；无 → 创建+记录）。 */
export interface WechatConversationResolver {
  resolveForMessage(input: {
    teacherId: string;
    externalConversationId: string;
  }): Promise<Result<string, CommonError>>;
}

/** Agent 闭环执行器：会话解析 + agent-converse（clientRequestId 幂等）。 */
export interface WechatAgentLoop {
  execute(input: {
    teacherId: string;
    message: NormalizedInboundMessage;
    botId?: string | null;
  }): Promise<Result<{ reply: string | null }, CommonError>>;
}

/** 出站回复发送器：iLink reply 语义（纯文本分片 ≤1500 [1/3]；经 wechat-bot adapter + outbound 落表）。 */
export interface WechatOutboundSender {
  sendReply(input: {
    teacherId: string;
    targetExternalUserId: string;
    text: string;
    correlationId: string;
  }): Promise<Result<{ sentChunks: number }, CommonError>>;
}

/** 未绑定恢复扫描：定时扫 status=new → 绑定已补充则重试入队；超时未绑置 failed。 */
export interface WechatUnboundRecoveryScanner {
  start(): void;
  stop(): void;
  scanOnce(): Promise<Result<{ recovered: number; failedStale: number }, CommonError>>;
}

/** 供应商驱动抽象（D37 §6.1 / 设计 §4.1）：隐藏 webhook 推送 / 长轮询拉取差异。
 *  S2 webhook 路由为入站（push 模式）；长轮询（pull）实现见 ilink-long-poll-driver.ts（W0 已冻结）。 */
export interface WechatProviderDriver {
  start(onMessage: (raw: unknown) => Promise<void>): Promise<Result<void, CommonError>>;
  stop(): Promise<Result<void, CommonError>>;
  getStatus(): Promise<Result<WechatDriverStatus, CommonError>>;
}

export type WechatDriverStatus = 'connected' | 'connecting' | 'stopped' | 'error';
