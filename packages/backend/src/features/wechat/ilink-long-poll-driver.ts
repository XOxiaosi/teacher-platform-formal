import { createHash } from 'node:crypto';
import { err, internalError, ok, type CommonError, type Result } from '@teacher-platform/contracts';
import type { Logger } from '../../shared/logger/index.js';
import {
  ILINK_CHANNEL_VERSION,
  ILINK_ENDPOINT_GET_UPDATES,
  ILINK_ITEM_TYPE_TEXT,
  ILINK_ITEM_TYPE_VOICE,
  isAbortError,
  isIlinkSessionExpiredError,
  type IlinkContextStore,
  type IlinkHttpClient,
} from './ilink-transport.js';
import type { NormalizedInboundMessage, WechatDriverStatus, WechatProviderDriver } from './types.js';

/**
 * iLink 入站长轮询驱动（W0 协议冻结，对齐 openhanako `lib/bridge/wechat-adapter.ts` pollLoop）。
 *
 * - `ilink/bot/getupdates` 长轮询 40s：单请求超时 = longPollTimeoutMs；超时（AbortError）属正常，
 *   立即续拉；`get_updates_buf` 游标随响应更新并回传（内存持有，阶段一不落盘）；
 * - 连续失败退避 [2000, 5000, 30000]ms；达 maxConsecutivePollFailures → 状态 error（继续退避重试）；
 *   `errcode=-14`（session 过期）→ 终止轮询（不可恢复，等重新扫码）；
 * - 入站消息归一化：parseIlinkInboundMessage（自发消息 @im.bot 过滤、文本/语音转文字提取、
 *   externalMessageId 派生、context_token 捕获写 store）；
 * - 生命周期：start（缺 bot_token fail-closed）/ stop（中止在途请求 + 清定时器）/ getStatus。
 * 时间纪律：TTL/退避用 performance.now() 单调时钟 + setTimeout，不写业务时间。
 */

// ── context_token 存储实现 ──────────────────────────────────────────────────

export interface CreateIlinkContextStoreOptions {
  /** TTL（ms；默认 24h，env WECHAT_ILINK_CONTEXT_TOKEN_TTL_MS）。 */
  ttlMs: number;
  /** 单调时钟（测试注入；缺省 performance.now）。 */
  nowMs?: () => number;
}

export function createIlinkContextStore(options: CreateIlinkContextStoreOptions): IlinkContextStore {
  const ttlMs = options.ttlMs > 0 ? options.ttlMs : 24 * 60 * 60 * 1000;
  const nowMs = options.nowMs ?? (() => performance.now());
  const store = new Map<string, { token: string; expiresAtMs: number }>();

  return {
    set(chatId, token) {
      if (!chatId || !token) return;
      store.set(chatId, { token, expiresAtMs: nowMs() + ttlMs });
    },
    get(chatId) {
      const entry = store.get(chatId);
      if (!entry) return null;
      if (entry.expiresAtMs <= nowMs()) {
        store.delete(chatId);
        return null;
      }
      return entry.token;
    },
    size() {
      return store.size;
    },
    sweep() {
      const now = nowMs();
      for (const [chatId, entry] of store) {
        if (entry.expiresAtMs <= now) store.delete(chatId);
      }
    },
  };
}

// ── 入站消息归一化（iLink raw msg → NormalizedInboundMessage）────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 文本提取（openhanako extractText）：text_item.text 优先；语音转文字 voice_item.text 兜底。
 * 引用消息（ref_msg）与媒体（image/file/video）W0 不处理（S3 媒体线）。
 */
export function extractIlinkText(itemList: unknown): string {
  if (!Array.isArray(itemList)) return '';
  for (const item of itemList) {
    if (!isRecord(item)) continue;
    if (item.type === ILINK_ITEM_TYPE_TEXT && isRecord(item.text_item) && typeof item.text_item.text === 'string') {
      return item.text_item.text;
    }
    if (item.type === ILINK_ITEM_TYPE_VOICE && isRecord(item.voice_item) && typeof item.voice_item.text === 'string') {
      return item.voice_item.text;
    }
  }
  return '';
}

/**
 * externalMessageId 派生（重投判定依据，W0 冻结）：
 * 优先 msg_id / message_id / client_id（供应商稳定 ID）；缺省 → 确定性 sha256(from|to|ts|text) 前 32 hex；
 * 全部可哈希组件为空 → undefined（无 ID 且无内容，无法判定重投）。
 */
export function deriveIlinkExternalMessageId(msg: Record<string, unknown>): string | undefined {
  const stableId = readString(msg.msg_id) ?? readString(msg.message_id) ?? readString(msg.client_id);
  if (stableId) return stableId;
  const parts = [
    msg.from_user_id ?? '',
    msg.to_user_id ?? '',
    msg.create_time ?? msg.ts ?? '',
    extractIlinkText(msg.item_list),
  ];
  if (!parts.some((part) => typeof part === 'string' && part.trim() !== '')) return undefined;
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** iLink raw 入站消息（getupdates msgs[] 元素）→ 标准化消息；跳过（自发/无文本）返回 null。 */
export function parseIlinkInboundMessage(raw: unknown): NormalizedInboundMessage | null {
  if (!isRecord(raw)) return null;
  const from = readString(raw.from_user_id);
  if (!from || from.endsWith('@im.bot')) return null; // 机器人自己发送的消息过滤（D37 §4.2 第 2 步）

  const externalMessageId = deriveIlinkExternalMessageId(raw);
  if (!externalMessageId) return null;

  const text = extractIlinkText(raw.item_list);
  if (!text) return null; // W0 仅文本（含语音转文字）；图片/文件/视频 → S3 媒体线

  const to = readString(raw.to_user_id);
  const message: NormalizedInboundMessage = {
    channel: 'wechat',
    externalMessageId,
    fromExternalUserId: from,
    ...(to ? { toExternalUserId: to } : {}),
    conversationType: 'private', // iLink 个人号私聊（群聊不在范围，D37 §2）
    messageType: 'text',
    text,
  };
  const contextToken = readString(raw.context_token);
  if (contextToken) {
    message.replyContext = { contextToken }; // provider opaque，不进模型/工具参数
  }
  return message;
}

/** 从归一化消息取 replyContext.contextToken（driver 捕获写 store 用）。 */
export function replyContextToken(message: NormalizedInboundMessage): string | null {
  if (isRecord(message.replyContext)) {
    const token = message.replyContext.contextToken;
    return typeof token === 'string' && token.trim() !== '' ? token : null;
  }
  return null;
}

// ── 长轮询驱动 ──────────────────────────────────────────────────────────────

export interface CreateIlinkLongPollDriverOptions {
  /** 平台级 iLink 配置子集（W0 传输参数）。 */
  config: {
    apiBaseUrl: string;
    botToken: string;
    longPollTimeoutMs: number;
    pollBackoffMs: number[];
    maxConsecutivePollFailures: number;
  };
  client: IlinkHttpClient;
  contextStore: IlinkContextStore;
  logger?: Logger;
}

export function createIlinkLongPollDriver(options: CreateIlinkLongPollDriverOptions): WechatProviderDriver {
  let generation = 0;
  let abortController = new AbortController();
  let status: WechatDriverStatus = 'stopped';
  let getUpdatesBuf = '';
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function setStatus(next: WechatDriverStatus): void {
    if (status === next) return;
    status = next;
    options.logger?.info('wechat ilink driver status', { driverStatus: status });
  }

  /** 退避休眠（stop/换代即中断，返回是否仍存活）。 */
  function guardedSleep(ms: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        timers.delete(id);
        resolve(myGen === generation);
      }, ms);
      timers.add(id);
    });
  }

  function backoffDelay(consecutiveFailures: number): number {
    const delays = options.config.pollBackoffMs.length > 0 ? options.config.pollBackoffMs : [2000, 5000, 30_000];
    return delays[Math.min(consecutiveFailures - 1, delays.length - 1)];
  }

  async function pollLoop(onMessage: (raw: unknown) => Promise<void>): Promise<void> {
    const myGen = generation;
    let consecutiveFailures = 0;
    setStatus('connecting');

    while (myGen === generation) {
      let result: Result<unknown, CommonError>;
      try {
        result = await options.client.post(
          ILINK_ENDPOINT_GET_UPDATES,
          {
            get_updates_buf: getUpdatesBuf,
            base_info: { channel_version: ILINK_CHANNEL_VERSION },
          },
          { timeoutMs: options.config.longPollTimeoutMs, signal: abortController.signal },
        );
      } catch (error) {
        if (myGen !== generation) return; // stop 中断
        if (isAbortError(error)) continue; // 长轮询 40s 超时：正常，立即续拉
        consecutiveFailures += 1;
        if (consecutiveFailures >= options.config.maxConsecutivePollFailures) {
          setStatus('error');
          options.logger?.error('wechat ilink long-poll failed', { error: String(error) });
        }
        const alive = await guardedSleep(backoffDelay(consecutiveFailures), myGen);
        if (!alive) return;
        continue;
      }

      if (myGen !== generation) return;
      if (!result.ok) {
        // 业务/网络错误（非 abort）
        if (isIlinkSessionExpiredError(result.error)) {
          setStatus('error'); // session 过期：不可恢复，终止轮询（等重新扫码）
          options.logger?.warn('wechat ilink session expired, polling stopped', { error: result.error });
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= options.config.maxConsecutivePollFailures) {
          setStatus('error');
          options.logger?.error('wechat ilink long-poll error', { error: result.error });
        }
        const alive = await guardedSleep(backoffDelay(consecutiveFailures), myGen);
        if (!alive) return;
        continue;
      }

      consecutiveFailures = 0;
      setStatus('connected');

      const resp = isRecord(result.value) ? result.value : {};
      if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf !== '') {
        getUpdatesBuf = resp.get_updates_buf; // 游标随响应推进（重拉不重放）
      }
      const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
      for (const rawMsg of msgs) {
        if (myGen !== generation) return;
        const message = parseIlinkInboundMessage(rawMsg);
        if (!message) continue;
        const contextToken = replyContextToken(message);
        if (contextToken) options.contextStore.set(message.fromExternalUserId, contextToken);
        try {
          await onMessage(message); // 本 driver 投递已归一化的 NormalizedInboundMessage
        } catch (handlerError) {
          options.logger?.error('wechat ilink inbound handler failed', {
            error: handlerError instanceof Error ? handlerError.message : String(handlerError),
            externalMessageId: message.externalMessageId,
          });
        }
      }
    }
  }

  return {
    async start(onMessage) {
      if (!options.config.botToken) {
        return err(internalError('iLink bot_token 未配置（WECHAT_ILINK_BOT_TOKEN），长轮询驱动无法启动'));
      }
      if (status !== 'stopped') {
        return err(internalError('iLink 长轮询驱动已在运行'));
      }
      generation += 1; // 每次 start 新代次（stop 后重启安全）
      abortController = new AbortController();
      getUpdatesBuf = '';
      setStatus('connecting');
      void pollLoop(onMessage);
      return ok(undefined);
    },
    async stop() {
      generation += 1;
      abortController.abort(); // 中断在途 getupdates
      for (const t of timers) clearTimeout(t);
      timers.clear();
      setStatus('stopped');
      return ok(undefined);
    },
    async getStatus() {
      return ok(status);
    },
  };
}
