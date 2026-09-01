import { validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { NormalizedInboundMessage } from './types.js';

/**
 * 供应商驱动抽象（P8 t13，设计 p7-wechat-ilink-design.md §4.1 / D37 §6.1）。
 *
 * WechatProviderDriver 接口见 types.ts——隐藏 webhook 推送 / 长轮询拉取差异：
 * - S2 入站 = webhook 路由（push 模式，本文件提供 payload 归一化共用逻辑）；
 * - 长轮询（pull）实现 = ilink-long-poll-driver.ts（W0 已冻结：iLink 40s 长轮询 + bot_token 鉴权，
 *   拉到 raw payload 后经 parseIlinkInboundMessage 归一化 → inboundService 同流水线）。
 * 业务层只消费 NormalizedInboundMessage，不感知传输差异。
 */

/** 供应商原始 payload → 标准化入站消息（webhook 路由与未来长轮询 driver 共用）。 */
export function parseWechatInboundPayload(raw: unknown): Result<NormalizedInboundMessage, CommonError> {
  if (typeof raw !== 'object' || raw === null) {
    return validationErrorResult('消息体必须是 JSON 对象');
  }
  const body = raw as Record<string, unknown>;

  const externalMessageId = readString(body, 'externalMessageId');
  const fromExternalUserId = readString(body, 'fromExternalUserId');
  const text = readString(body, 'text');
  if (!externalMessageId) return validationErrorResult('缺少 externalMessageId');
  if (!fromExternalUserId) return validationErrorResult('缺少 fromExternalUserId');
  if (!text) return validationErrorResult('缺少 text');

  const conversationType = body.conversationType === 'group' ? 'group' : 'private';
  const messageType = body.messageType === 'text' ? 'text' : 'unsupported';
  if (messageType === 'unsupported') {
    return validationErrorResult('S2 仅支持 text 消息类型');
  }

  return {
    ok: true,
    value: {
      channel: 'wechat',
      externalMessageId,
      fromExternalUserId,
      ...(typeof body.toExternalUserId === 'string' && body.toExternalUserId
        ? { toExternalUserId: body.toExternalUserId }
        : {}),
      conversationType,
      messageType,
      text,
      ...(body.replyContext !== undefined ? { replyContext: body.replyContext } : {}),
    },
  };
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function validationErrorResult(message: string): Result<never, CommonError> {
  return { ok: false, error: validationError(message, 'body') };
}
