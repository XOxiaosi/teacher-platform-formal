import { err, internalError, ok, rateLimited, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { RateLimiter } from '../../shared/rate-limit/index.js';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';

import { splitText, type WechatTextAdapter } from './outbound.js';
import type { ChannelIdentityService, ChannelMessageService } from './types.js';
import { WECHAT_PLATFORM } from './types.js';

/**
 * S4 主动推送（P8 t21，设计 p7-wechat-ilink-design.md §4.6/§6/§7 S4 切片）。
 *
 * - parseWechatNotifyToolCall：解析 iLink notify 工具调用——`channels=["bridge_owner"]` +
 *   `bridgePlatforms=["wechat"]` 缺一不可（D51 §4.2 已验证的个人号主动推送形态）；
 * - createWechatNotifier：定时/触发式主动推送（morning_brief/evening_review 语义复用 PushRecord 既有 type，
 *   本模块不落 PushRecord——PushRecord 收件人改造见 features/push + createWechatPushRecipientResolver）：
 *   - 收件人：teacherId → ChannelIdentity → 外部 wxid（无绑定 → skipped，不发送）；
 *   - 限流：复用 RateLimiter，出站 1min/60（env WECHAT_ILINK_NOTIFY_PER_MIN，建议值）；
 *   - 幂等：出站 externalMessageId = `out:notify:<correlationId>:<chunkIndex>`（channelMessageService
 *     recordOutbound 的 @@unique([channel, externalMessageId]) 持久幂等）——同 correlationId 重放
 *     首片已 sent → replayed（不重发）；失败 status=failed 可重试；
 *   - 时间：processedAtTs 走 TrustedClock（业务时间纪律，不取墙钟）；
 *   - 出站走 wechat-bot adapter send（真实 transport 由 W0 协议冻结后接入，stub 明确失败 fail-closed）。
 */

// ---- notify 工具调用解析 ----

type PushChannel = 'wechat-bot' | 'wecom' | 'telegram';
type PushRecipientResolver = (input: {
  teacherId: string;
  channel: PushChannel;
}) => Promise<Result<{ externalId: string } | null, CommonError>>;

export const WECHAT_NOTIFY_CHANNEL = 'bridge_owner';
export const WECHAT_NOTIFY_PLATFORM = 'wechat';

export interface WechatNotifyToolCall {
  title: string;
  body: string;
  channels: string[];
  bridgePlatforms: string[];
}

/**
 * 解析 iLink notify 工具调用（openhanako notify-tool 参数形态）：
 * `{title, body, channels: ["bridge_owner"], bridgePlatforms: ["wechat"]}`。
 * channels 必须包含 bridge_owner、bridgePlatforms 必须包含 wechat（缺一不可）。
 */
export function parseWechatNotifyToolCall(payload: unknown): Result<WechatNotifyToolCall, CommonError> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return err(validationError('notify 工具调用必须是对象', 'body'));
  }
  const body = payload as Record<string, unknown>;
  const title = readString(body.title);
  const content = readString(body.body);
  if (!title) return err(validationError('缺少 title', 'title'));
  if (!content) return err(validationError('缺少 body', 'body'));
  const channels = readStringArray(body.channels);
  const bridgePlatforms = readStringArray(body.bridgePlatforms);
  if (!channels) return err(validationError('channels 必须是字符串数组', 'channels'));
  if (!bridgePlatforms) return err(validationError('bridgePlatforms 必须是字符串数组', 'bridgePlatforms'));
  if (!channels.includes(WECHAT_NOTIFY_CHANNEL)) {
    return err(validationError(`channels 必须包含 ${WECHAT_NOTIFY_CHANNEL}`, 'channels'));
  }
  if (!bridgePlatforms.includes(WECHAT_NOTIFY_PLATFORM)) {
    return err(validationError(`bridgePlatforms 必须包含 ${WECHAT_NOTIFY_PLATFORM}`, 'bridgePlatforms'));
  }
  return ok({ title, body: content, channels, bridgePlatforms });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  if (strings.length !== value.length) return undefined;
  return strings;
}

// ---- 主动推送发送器 ----

export interface CreateWechatNotifierOptions {
  channelMessageService: ChannelMessageService;
  identityService: ChannelIdentityService;
  adapter: WechatTextAdapter;
  clock: TrustedClock;
  /** 出站限流器（缺省不启用；建议装配期注入 createSlidingWindowLimiter） */
  limiter?: RateLimiter;
  /** 出站限流上限（1 分钟窗口；建议值 60，env WECHAT_ILINK_NOTIFY_PER_MIN） */
  notifyRatePerMin?: number;
  /** 单段长度上限（默认 1500，env WECHAT_ILINK_MAX_TEXT_LENGTH） */
  maxTextLength?: number;
  /** 出站 from 标识（bot；缺省 'wechat-bot' 占位） */
  botExternalUserId?: string;
}

export interface WechatNotifyInput {
  teacherId: string;
  /** 推送类型（复用 PushRecord 既有语义：morning_brief | evening_review；仅透传/审计，不落 PushRecord） */
  type: string;
  /** 幂等键（调用方派生：如 `morning-brief:<teacherId>:<businessDate>`；出站 id 前缀） */
  correlationId: string;
  /** 推送内容（回复模板渲染后的纯文本） */
  content: string;
}

export interface WechatNotifyResult {
  status: 'sent' | 'skipped' | 'replayed';
  sentChunks: number;
  targetExternalUserId: string | null;
}

export interface WechatNotifier {
  sendNotify(input: WechatNotifyInput): Promise<Result<WechatNotifyResult, CommonError>>;
}

export function createWechatNotifier(options: CreateWechatNotifierOptions): WechatNotifier {
  const notifyRatePerMin = options.notifyRatePerMin ?? 60;
  const maxTextLength = options.maxTextLength ?? 1500;
  const botExternalUserId = options.botExternalUserId ?? 'wechat-bot';

  return {
    async sendNotify(input) {
      if (!input.teacherId.trim()) return err(validationError('教师 ID 不能为空', 'teacherId'));
      if (!input.correlationId.trim()) return err(validationError('幂等键不能为空', 'correlationId'));
      if (!input.content.trim()) return err(validationError('推送内容不能为空', 'content'));

      // 1. 出站限流（复用 RateLimiter；键 wechat:notify:<teacherId>）
      if (options.limiter) {
        const limit = await options.limiter.check(`wechat:notify:${input.teacherId}`, 60_000, notifyRatePerMin);
        if (!limit.allowed) {
          return err(rateLimited('主动推送过于频繁，请稍后重试'));
        }
      }

      // 2. 收件人解析：teacherId → ChannelIdentity → 外部 wxid（无绑定 → skipped，不发送）
      const bindings = await options.identityService.listByTeacher({
        teacherId: input.teacherId,
        platform: WECHAT_PLATFORM,
      });
      if (!bindings.ok) return bindings;
      const target = bindings.value[0]?.externalUserId ?? null;
      if (!target) {
        return ok({ status: 'skipped', sentChunks: 0, targetExternalUserId: null });
      }

      // 3. 幂等预检：首片 `out:notify:<correlationId>:0` 已 sent → replayed（不重发）
      // 注意：getByExternalMessageId 返回行 status 为入站状态机（new|queued|processed|failed），
      // 出站行 recordOutbound 用同一表（status=sent|failed）——故用字符串比较而非类型收窄。
      const firstExternalId = `out:notify:${input.correlationId}:0`;
      const existing = await options.channelMessageService.getByExternalMessageId('wechat', firstExternalId);
      if (!existing.ok) return existing;
      if (existing.value && (existing.value.status as string) === 'sent') {
        return ok({ status: 'replayed', sentChunks: 0, targetExternalUserId: target });
      }

      // 4. TrustedClock（业务时间纪律）
      const now = await options.clock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock 返回无效时间'));
      }

      // 5. 分片发送 + outbound 落表（correlationId=`notify:<correlationId>` → 持久幂等）
      const chunks = splitText(input.content, maxTextLength);
      let sent = 0;
      for (let i = 0; i < chunks.length; i++) {
        const content = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n${chunks[i]}` : chunks[i];
        const sendResult = await options.adapter.send({ to: target, content });
        if (!sendResult.ok) {
          await options.channelMessageService.recordOutbound({
            channel: 'wechat',
            teacherId: input.teacherId,
            correlationId: `notify:${input.correlationId}`,
            chunkIndex: i,
            fromExternalUserId: botExternalUserId,
            toExternalUserId: target,
            contentText: content,
            status: 'failed',
            errorMsg: sendResult.error.message,
            processedAt: now.value,
          });
          return err(sendResult.error);
        }
        const record = await options.channelMessageService.recordOutbound({
          channel: 'wechat',
          teacherId: input.teacherId,
          correlationId: `notify:${input.correlationId}`,
          chunkIndex: i,
          fromExternalUserId: botExternalUserId,
          toExternalUserId: target,
          contentText: content,
          status: 'sent',
          processedAt: now.value,
        });
        if (!record.ok) return record;
        sent += 1;
      }
      return ok({ status: 'sent', sentChunks: sent, targetExternalUserId: target });
    },
  };
}

// ---- PushRecord 收件人解析（D37 §4.3 缺口收口）----

/**
 * 微信渠道收件人解析器（PushRecipientResolver 的 wechat 实现）：
 * - channel 为 wechat-bot（微信推送渠道）时：teacherId → ChannelIdentity → 外部 wxid；
 *   无绑定 → null（pushService 记 status='skipped'，不调 adapter）；
 * - 其它渠道 → 原样返回 teacherId（既有行为不变，端口只对微信生效）。
 */
export function createWechatPushRecipientResolver(options: {
  identityService: ChannelIdentityService;
}): PushRecipientResolver {
  return async function resolveRecipient(input: { teacherId: string; channel: PushChannel }) {
    if (input.channel !== 'wechat-bot') {
      return ok({ externalId: input.teacherId });
    }
    const bindings = await options.identityService.listByTeacher({
      teacherId: input.teacherId,
      platform: WECHAT_PLATFORM,
    });
    if (!bindings.ok) return bindings;
    const target = bindings.value[0]?.externalUserId ?? null;
    return ok(target ? { externalId: target } : null);
  };
}
