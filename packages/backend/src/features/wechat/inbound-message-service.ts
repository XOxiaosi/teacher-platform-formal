import { err, internalError, notFound, ok } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type {
  ChannelIdentityService,
  ChannelMessageService,
  InboundMessageService,
  NormalizedInboundMessage,
  QueuePort,
  WechatAgentLoop,
  WechatOutboundSender,
} from './types.js';

export const WECHAT_MESSAGE_CHANNEL = 'wechat';

/**
 * 入站消息服务（P8 t13 S2 + t16 S3，设计 p7-wechat-ilink-design.md §4.2/§5）。
 *
 * receiveWebhook：webhook 入口——claim（持久幂等）→ 入队，5s 内 200 硬约束（不做重活）；
 * processMessage：队列 worker——
 *   - 未绑定 → 状态回置 new 挂起（不触发 Agent；恢复扫描绑定后补处理）；
 *   - 已绑定 → Agent 闭环（S3）：agentLoop.execute（会话解析 + agent-converse，
 *     clientRequestId=wechat:<botId>:<externalMessageId> 幂等）→ 出站回复（分片/落表）→
 *     processed + TrustedClock processedAtTs；
 *   - Agent/出站失败 → status=failed + errorMsg（可重试，幂等键防重复）。
 */

export interface CreateInboundMessageServiceOptions {
  channelMessageService: ChannelMessageService;
  identityService: ChannelIdentityService;
  queue: QueuePort;
  clock: TrustedClock;
  /** S3：Agent 闭环（可选——未接线时保持 S2 行为：绑定即 processed）。 */
  agentLoop?: WechatAgentLoop;
  /** S3：出站回复发送器（可选——未接线时只 processed 不回）。 */
  outbound?: WechatOutboundSender;
}

export function createInboundMessageService(
  options: CreateInboundMessageServiceOptions,
): InboundMessageService {
  const { channelMessageService, identityService, queue, clock, agentLoop, outbound } = options;

  async function receiveWebhook(msg: NormalizedInboundMessage) {
    const claimResult = await channelMessageService.claim({
      channel: msg.channel,
      externalMessageId: msg.externalMessageId,
      fromExternalUserId: msg.fromExternalUserId,
      toExternalUserId: msg.toExternalUserId,
      contentType: msg.messageType,
      contentText: msg.text,
    });
    if (!claimResult.ok) return claimResult;
    if (claimResult.value.duplicate) {
      // 重投：不重复落行/不重新入队（持久幂等）
      return ok({ accepted: true, duplicate: true });
    }
    const queued = await channelMessageService.markQueued(claimResult.value.row.id);
    if (!queued.ok) return queued;
    const enqueueResult = await queue.enqueue(msg);
    if (!enqueueResult.ok) {
      // 队列满/停止：标记 failed（恢复扫描可重试），webhook 侧返回 503 让供应商重试
      await channelMessageService.markFailed(claimResult.value.row.id, { errorMsg: enqueueResult.error.message });
      return enqueueResult;
    }
    return ok({ accepted: true, duplicate: false });
  }

  async function processMessage(msg: NormalizedInboundMessage) {
    const rowResult = await channelMessageService.getByExternalMessageId(
      msg.channel,
      msg.externalMessageId,
    );
    if (!rowResult.ok) return rowResult;
    const row = rowResult.value;
    if (!row) return err(notFound('入站消息不存在'));

    if (row.status === 'processed') {
      return ok({ status: 'already' as const }); // 幂等：重放不重复处理
    }

    // ChannelIdentity 解析绑定（teacherId + botId；iLink 身份 → 教师路由）
    const binding = await identityService.resolveChannelBinding({
      platform: msg.channel,
      externalUserId: msg.fromExternalUserId,
    });
    if (!binding.ok) return binding;
    if (!binding.value) {
      // 未绑定：挂起（status=new），不触发 Agent（恢复扫描补处理）
      const pending = await channelMessageService.markPending(row.id);
      if (!pending.ok) return pending;
      return ok({ status: 'unbound' as const });
    }
    const { teacherId, providerChannelId } = binding.value;

    // S3：Agent 闭环（已绑定）
    if (agentLoop) {
      const agentResult = await agentLoop.execute({
        teacherId,
        message: msg,
        botId: providerChannelId,
      });
      if (!agentResult.ok) {
        await channelMessageService.markFailed(row.id, { errorMsg: agentResult.error.message });
        return ok({ status: 'failed' as const });
      }
      const reply = agentResult.value.reply;
      if (reply && outbound) {
        const sendResult = await outbound.sendReply({
          teacherId,
          targetExternalUserId: msg.fromExternalUserId,
          text: reply,
          correlationId: msg.externalMessageId,
        });
        if (!sendResult.ok) {
          await channelMessageService.markFailed(row.id, { errorMsg: sendResult.error.message });
          return ok({ status: 'failed' as const });
        }
      }
    }

    // 完成：processed + TrustedClock processedAtTs
    const now = await clock.now();
    if (!now.ok) return err(now.error);
    if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
      return err(internalError('TrustedClock 返回无效时间'));
    }
    const processed = await channelMessageService.markProcessed(row.id, {
      teacherId,
      processedAt: now.value,
    });
    if (!processed.ok) return processed;
    return ok({ status: 'processed' as const });
  }

  return { receiveWebhook, processMessage };
}
