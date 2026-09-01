import { ok, type CommonError, type Result } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type { ChannelMessageService, WechatOutboundSender } from './types.js';

/**
 * S3 出站回复发送器（P8 t16，设计 p7-wechat-ilink-design.md §4.4/§4.5）。
 *
 * - iLink reply 语义（客服消息）：纯文本分片 ≤maxTextLength（默认 1500），多段加 [1/N] 标记；
 * - 每片经 adapter.send（wechat-bot 出站骨架，W0 协议冻结后接真实 transport）发送；
 * - 出站 ChannelMessage（direction=outbound）落表：externalMessageId=`out:<correlationId>:<chunkIndex>`
 *   确定性幂等（重试/重放不重复发）；processedAtTs 走 TrustedClock；
 * - 任一片发送失败 → 该片落 failed 行并返回错误（入站侧由调用方 markFailed，可重试）。
 */

export interface WechatTextAdapter {
  send(input: { to: string; content: string }): Promise<Result<{ messageId?: string }, CommonError>>;
}

export interface CreateWechatOutboundSenderOptions {
  channelMessageService: ChannelMessageService;
  adapter: WechatTextAdapter;
  clock: TrustedClock;
  /** 单段长度上限（默认 1500，env WECHAT_ILINK_MAX_TEXT_LENGTH）。 */
  maxTextLength?: number;
  /** 出站消息 from 标识（bot；缺省 'wechat-bot' 占位，W0 后接真实 ilink_bot_id）。 */
  botExternalUserId?: string;
}

/** 纯文本分片：单段 ≤ maxLength；优先在段尾换行处切断（避免断词）。 */
export function splitText(text: string, maxLength: number): string[] {
  if (maxLength <= 0) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.slice(0, maxLength);
    const newline = slice.lastIndexOf('\n');
    // 段尾 50% 以后有换行则在那里切（保留语义），否则硬切
    const cut = newline > maxLength * 0.5 ? newline + 1 : maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

export function createWechatOutboundSender(options: CreateWechatOutboundSenderOptions): WechatOutboundSender {
  const maxTextLength = options.maxTextLength ?? 1500;
  const botExternalUserId = options.botExternalUserId ?? 'wechat-bot';

  return {
    async sendReply(input) {
      const now = await options.clock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return { ok: false as const, error: { code: 'INTERNAL_ERROR' as const, message: 'TrustedClock 返回无效时间' } };
      }
      if (!input.text || input.text.trim() === '') {
        return ok({ sentChunks: 0 }); // Agent 无回复：不发送
      }

      const chunks = splitText(input.text, maxTextLength);
      let sent = 0;
      for (let i = 0; i < chunks.length; i++) {
        const content = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n${chunks[i]}` : chunks[i];
        const sendResult = await options.adapter.send({ to: input.targetExternalUserId, content });
        if (!sendResult.ok) {
          await options.channelMessageService.recordOutbound({
            channel: 'wechat',
            teacherId: input.teacherId,
            correlationId: input.correlationId,
            chunkIndex: i,
            fromExternalUserId: botExternalUserId,
            toExternalUserId: input.targetExternalUserId,
            contentText: content,
            status: 'failed',
            errorMsg: sendResult.error.message,
            processedAt: now.value,
          });
          return sendResult;
        }
        const record = await options.channelMessageService.recordOutbound({
          channel: 'wechat',
          teacherId: input.teacherId,
          correlationId: input.correlationId,
          chunkIndex: i,
          fromExternalUserId: botExternalUserId,
          toExternalUserId: input.targetExternalUserId,
          contentText: content,
          status: 'sent',
          processedAt: now.value,
        });
        if (!record.ok) return record;
        sent += 1;
      }
      return ok({ sentChunks: sent });
    },
  };
}
