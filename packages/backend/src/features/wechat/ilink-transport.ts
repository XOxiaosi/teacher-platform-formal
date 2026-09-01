import { randomBytes, randomUUID } from 'node:crypto';
import { err, internalError, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { WechatTextAdapter } from './outbound.js';

/**
 * iLink 真实传输层（W0 协议冻结，对齐 openhanako `lib/bridge/wechat-adapter.ts`）。
 *
 * 契约冻结见 `reports/architecture/p9-w0-wechat-ilink-protocol-freeze.md`：
 * - 端点：`ilink/bot/sendmessage`（出站回复）、`ilink/bot/getupdates`（入站长轮询）等；
 * - 请求头：`Content-Type: application/json` + `AuthorizationType: ilink_bot_token` +
 *   `X-WECHAT-UIN`（随机 uint32 base64）+ `Authorization: Bearer <bot_token>`；
 * - 业务错误：HTTP 200 但 `ret !== 0` → 错误（含 errcode/errmsg）；`errcode=-14` = session 过期（终止轮询）；
 * - 出站回复前置条件：目标用户最近发过消息（context_token，24h TTL）——无 token 无法回复（iLink 语义）。
 *
 * 凭证纪律：bot_token 只从 config（env WECHAT_ILINK_BOT_TOKEN / S1 扫码交换）注入，不进仓库/测试；
 * 测试经 `fetchImpl` 注入 mock HTTP 层（W0 契约测试，真实凭证零落盘）。
 * 时间纪律：本模块无业务时间写入（client_id 用 randomUUID，无 new Date/Date.now）。
 */

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_ENDPOINT_SEND_MESSAGE = 'ilink/bot/sendmessage';
export const ILINK_ENDPOINT_GET_UPDATES = 'ilink/bot/getupdates';
export const ILINK_CHANNEL_VERSION = '1.0.0';

/** iLink item_list 类型常量（openhanako MessageItemType）。 */
export const ILINK_ITEM_TYPE_TEXT = 1;
export const ILINK_ITEM_TYPE_VOICE = 3;
/** 出站消息 message_type（BOT=2）/ message_state（FINISH=2）。 */
export const ILINK_MSG_TYPE_BOT = 2;
export const ILINK_MSG_STATE_FINISH = 2;

/** session 过期标记（openhanako isSessionExpiredError：ret/errcode=-14）。 */
const ILINK_SESSION_EXPIRED_MARKER = /(?:ret|errcode)=-14\b/;

// ── 工具 ───────────────────────────────────────────────────────────────────

/** 随机 X-WECHAT-UIN（openhanako randomWechatUin：uint32 → base64）。 */
export function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/** 请求头（W0 冻结：AuthorizationType + X-WECHAT-UIN + Bearer token）。 */
export function buildIlinkHeaders(botToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...(botToken ? { Authorization: `Bearer ${botToken}` } : {}),
  };
}

/** 是否为 abort（请求超时/外部中断）；调用方据此区分「长轮询超时（正常）」与「stop 中断」。 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** 业务错误是否表示 iLink session 过期（errcode=-14；不可恢复，等重新扫码）。 */
export function isIlinkSessionExpiredError(error: CommonError): boolean {
  return ILINK_SESSION_EXPIRED_MARKER.test(error.message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readRet(json: unknown): number | undefined {
  if (!isRecord(json)) return undefined;
  const ret = json.ret;
  return typeof ret === 'number' && Number.isFinite(ret) ? ret : undefined;
}

function readField(json: unknown, key: string): string {
  if (isRecord(json)) {
    const value = json[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

// ── context_token 存储（回复前置条件；长轮询 driver 写入、出站 transport 读取）──

/**
 * chatId → context_token 缓存（iLink 回复前置条件：对方最近发过消息；TTL 默认 24h）。
 * 单调时钟（performance.now()）TTL——非业务时间，不落库；driver 捕获写入、出站读取。
 */
export interface IlinkContextStore {
  set(chatId: string, token: string): void;
  get(chatId: string): string | null;
  size(): number;
  sweep(): void;
}

// ── HTTP client（请求形状 + 响应解析 + 错误归一）─────────────────────────────

export interface IlinkHttpClientOptions {
  apiBaseUrl: string;
  /** bot_token（W0 传输凭证；空 = fail-closed，出站/轮询明确报错）。 */
  botToken?: string;
  /** 一般请求超时（ms；getupdates 长轮询经 post opts.timeoutMs 单独指定）。 */
  requestTimeoutMs?: number;
  /** 测试注入的 fetch 实现（缺省 globalThis.fetch；契约测试 mock 用）。 */
  fetchImpl?: typeof fetch;
}

export interface IlinkPostOptions {
  /** 单请求超时（覆盖默认；getupdates 传 longPollTimeoutMs=40000）。 */
  timeoutMs?: number;
  /** 外部中止信号（driver stop 时中断在途请求）。 */
  signal?: AbortSignal;
}

export interface IlinkHttpClient {
  /**
   * POST JSON 到 iLink 端点。
   * - 成功（HTTP 2xx 且 ret=0/缺省）→ ok(响应 JSON)；
   * - HTTP 非 2xx / ret≠0 / JSON 非法 / 网络错误 → err(INTERNAL_ERROR，消息含端点与归一信息)；
   * - **仅超时/外部中止抛 AbortError**（调用方区分「长轮询 40s 超时正常续拉」与「stop 中断」）。
   */
  post(endpoint: string, body: unknown, opts?: IlinkPostOptions): Promise<Result<unknown, CommonError>>;
}

export function createIlinkHttpClient(options: IlinkHttpClientOptions): IlinkHttpClient {
  const baseUrl = options.apiBaseUrl.endsWith('/') ? options.apiBaseUrl : `${options.apiBaseUrl}/`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const botToken = options.botToken ?? '';

  return {
    async post(endpoint, body, opts = {}) {
      const url = new URL(endpoint, baseUrl).toString();
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onParentAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onParentAbort, { once: true });

      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: buildIlinkHeaders(botToken),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          return err(internalError(`${endpoint} HTTP ${res.status}: ${truncate(text)}`));
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return err(internalError(`${endpoint} 响应不是合法 JSON`));
        }
        const ret = readRet(json);
        if (ret !== undefined && ret !== 0) {
          return err(
            internalError(
              `${endpoint} ret=${ret} errcode=${readField(json, 'errcode')} errmsg=${truncate(readField(json, 'errmsg'), 120)}`,
            ),
          );
        }
        return ok(json);
      } catch (error) {
        if (isAbortError(error)) throw error; // 超时/外部中止：抛给调用方区分
        return err(internalError(`${endpoint} 网络错误: ${truncate(messageOf(error), 120)}`));
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

// ── 出站回复（ilink/bot/sendmessage）────────────────────────────────────────

/** 出站发送核心（Result 化，契约测试直接断言错误归一；transport/adapter 复用）。 */
export async function sendIlinkTextMessage(
  options: { client: IlinkHttpClient; contextStore: IlinkContextStore },
  input: { to: string; content: string },
): Promise<Result<{ messageId: string }, CommonError>> {
  if (!input.to.trim()) return err(validationError('接收方不能为空', 'to'));
  if (!input.content.trim()) return err(validationError('消息内容不能为空', 'content'));

  // iLink 语义：回复前置条件——对方最近发过消息才有 context_token（24h TTL）
  const contextToken = options.contextStore.get(input.to);
  if (!contextToken) {
    return err(validationError('对方最近未发消息，无法回复（缺少 context_token）', 'to'));
  }

  const clientId = randomUUID();
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: input.to,
      client_id: clientId,
      message_type: ILINK_MSG_TYPE_BOT,
      message_state: ILINK_MSG_STATE_FINISH,
      item_list: [{ type: ILINK_ITEM_TYPE_TEXT, text_item: { text: input.content } }],
      context_token: contextToken,
    },
    base_info: { channel_version: ILINK_CHANNEL_VERSION },
  };

  const result = await options.client.post(ILINK_ENDPOINT_SEND_MESSAGE, body);
  if (!result.ok) return result;

  // 响应解析：优先供应商返回的消息 ID；未返回则以 client_id 兜底（确定性幂等辅助）。
  const messageId =
    readString((result.value as Record<string, unknown> | null)?.['msg_id'])
    ?? readString((result.value as Record<string, unknown> | null)?.['message_id'])
    ?? clientId;
  return ok({ messageId });
}

/**
 * 出站适配器（WechatTextAdapter 形状：Result 信封，错误码与 CommonError 心智对齐）。
 * 装配期注入 outbound/notifier；真实凭证只经 config（env）进入 client，测试注入 mock client。
 */
export function createIlinkOutboundAdapter(options: {
  client: IlinkHttpClient;
  contextStore: IlinkContextStore;
}): WechatTextAdapter {
  return {
    async send(input) {
      const result = await sendIlinkTextMessage(options, input);
      if (!result.ok) return result;
      return ok({ messageId: result.value.messageId });
    },
  };
}
