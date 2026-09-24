import { describe, expect, it, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import {
  createWechatOutboundSender,
  formatTextChunks,
  splitText,
} from '../../../src/features/wechat/outbound.js';
import type {
  ChannelMessageDto,
  ChannelMessageService,
} from '../../../src/features/wechat/types.js';

const at = new Date('2030-01-01T00:00:00.000Z');

function row(status: ChannelMessageDto['status']): ChannelMessageDto {
  return {
    id: 'outbound-1',
    teacherId: 'teacher-1',
    channel: 'wechat',
    externalMessageId: 'out:message-1:0',
    fromExternalUserId: 'wechat-bot',
    toExternalUserId: 'wx-1',
    direction: 'outbound',
    contentType: 'text',
    contentText: '回复',
    status,
    errorMsg: null,
    processedAtTs: status === 'sent' ? at : null,
    createdAtTs: at,
  };
}

function service(input: {
  claimState: 'claimed' | 'sent' | 'uncertain';
  completeOk?: boolean;
}) {
  const claimedRow = row(input.claimState === 'claimed' ? 'sending' : input.claimState === 'sent' ? 'sent' : 'failed');
  return {
    claimOutbound: vi.fn(async () => ok({ row: claimedRow, state: input.claimState })),
    completeOutbound: vi.fn(async ({ status }: { status: 'sent' | 'failed' }) => (
      input.completeOk === false
        ? { ok: false as const, error: { code: 'INTERNAL_ERROR' as const, message: '结果保存失败' } }
        : ok(row(status))
    )),
  } as unknown as ChannelMessageService & {
    claimOutbound: ReturnType<typeof vi.fn>;
    completeOutbound: ReturnType<typeof vi.fn>;
  };
}

function sender(channelMessages: ChannelMessageService, send = vi.fn(async () => ok({ messageId: 'remote-1' }))) {
  return {
    send,
    outbound: createWechatOutboundSender({
      channelMessageService: channelMessages,
      adapter: { send },
      clock: { now: async () => ok(at) },
    }),
  };
}

const request = {
  teacherId: 'teacher-1',
  targetExternalUserId: 'wx-1',
  text: '回复',
  correlationId: 'message-1',
};

describe('微信回复文本分片', () => {
  it('短文本保持单片', () => {
    expect(splitText('你好', 1500)).toEqual(['你好']);
  });

  it('长文本分片后保持内容与长度上限', () => {
    const long = 'x'.repeat(4000);
    const chunks = splitText(long, 1500);
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
    expect(chunks.join('')).toBe(long);
  });

  it('优先在段尾换行处切断', () => {
    const text = `${'a'.repeat(1200)}\n${'b'.repeat(600)}`;
    const chunks = splitText(text, 1500);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith('\n')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('非正长度上限保持兼容行为', () => {
    expect(splitText('abc', 0)).toEqual(['abc']);
  });

  it('把多片编号前缀计入实际发送长度上限', () => {
    const chunks = formatTextChunks('x'.repeat(4000), 1500);
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
    expect(chunks.map((chunk) => chunk.replace(/^\[\d+\/\d+\]\n/, '')).join('')).toBe('x'.repeat(4000));
  });
});

describe('微信回复出站幂等', () => {
  it('先占位再发送，成功后收口 sent', async () => {
    const messages = service({ claimState: 'claimed' });
    const { outbound, send } = sender(messages);

    await expect(outbound.sendReply(request)).resolves.toEqual(ok({ sentChunks: 1 }));
    expect(messages.claimOutbound).toHaveBeenCalledBefore(send);
    expect(send).toHaveBeenCalledOnce();
    expect(messages.completeOutbound).toHaveBeenCalledWith({
      id: 'outbound-1', status: 'sent', processedAt: at,
    });
  });

  it('已有 sent 回执时直接跳过，不重复触发 adapter', async () => {
    const messages = service({ claimState: 'sent' });
    const { outbound, send } = sender(messages);

    await expect(outbound.sendReply(request)).resolves.toEqual(ok({ sentChunks: 0 }));
    expect(send).not.toHaveBeenCalled();
    expect(messages.completeOutbound).not.toHaveBeenCalled();
  });

  it('已有 sending/failed 不确定回执时停止自动重发', async () => {
    const messages = service({ claimState: 'uncertain' });
    const { outbound, send } = sender(messages);

    const result = await outbound.sendReply(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('状态不确定');
    expect(send).not.toHaveBeenCalled();
  });

  it('adapter 明确失败时保存 failed；发送成功但回执保存失败时如实返回失败', async () => {
    const failedMessages = service({ claimState: 'claimed' });
    const transportFailure = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'INTERNAL_ERROR' as const, message: 'transport 失败' },
    }));
    const failed = sender(failedMessages, transportFailure);
    await expect(failed.outbound.sendReply(request)).resolves.toMatchObject({ ok: false });
    expect(failedMessages.completeOutbound).toHaveBeenCalledWith({
      id: 'outbound-1', status: 'failed', errorMsg: 'transport 失败', processedAt: at,
    });

    const receiptMessages = service({ claimState: 'claimed', completeOk: false });
    const receipt = sender(receiptMessages);
    await expect(receipt.outbound.sendReply(request)).resolves.toMatchObject({
      ok: false,
      error: { message: '结果保存失败' },
    });
  });
});
