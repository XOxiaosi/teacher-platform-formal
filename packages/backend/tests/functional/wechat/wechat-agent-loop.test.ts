import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import type { AgentConverseUseCase } from '../../../src/app/use-cases/agent-converse/index.js';
import type { ConversationService } from '../../../src/features/conversation/index.js';
import {
  channelMessageRowToInbound,
  createChannelIdentityService,
  createChannelMessageService,
  createInboundMessageService,
  createInMemoryMessageQueue,
  createWechatAgentLoop,
  createWechatConversationResolver,
  createWechatOutboundSender,
  createWechatUnboundRecoveryScanner,
  deriveClientRequestId,
  WECHAT_PLATFORM,
  type ChannelIdentityService,
  type NormalizedInboundMessage,
  type WechatTextAdapter,
} from '../../../src/features/wechat/index.js';

const prisma = new PrismaClient();

const createdTeacherIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  await prisma.channelMessage.deleteMany({});
  await prisma.channelIdentity.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.conversationTurn.deleteMany({ where: { conversationId: { in: createdConversationIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function uniqueEmail(): string {
  return `wx-s3-${randomBytes(6).toString('hex')}@example.com`;
}

async function createTeacher(): Promise<string> {
  const teacher = await prisma.teacherRegistry.create({
    data: { email: uniqueEmail(), passwordHash: 'scrypt$test$test', displayName: 'S3 测试教师' },
  });
  createdTeacherIds.push(teacher.id);
  return teacher.id;
}

async function bindTeacher(teacherId: string, externalUserId: string, botId: string): Promise<void> {
  const identity: ChannelIdentityService = createChannelIdentityService({ prisma });
  const result = await identity.bind({
    teacherId,
    platform: WECHAT_PLATFORM,
    externalUserId,
    providerChannelId: botId,
  });
  expect(result.ok).toBe(true);
}

function message(externalMessageId: string, from: string, text: string): NormalizedInboundMessage {
  return {
    channel: 'wechat',
    externalMessageId,
    fromExternalUserId: from,
    conversationType: 'private',
    messageType: 'text',
    text,
  };
}

function fakeAdapter(sendImpl?: WechatTextAdapter['send']): WechatTextAdapter & { sends: Array<{ to: string; content: string }> } {
  const sends: Array<{ to: string; content: string }> = [];
  return {
    sends,
    async send(input) {
      sends.push(input);
      if (sendImpl) return sendImpl(input);
      return ok({ messageId: `msg-${sends.length}` });
    },
  };
}

function fakeAgentConverse(reply: string | null = '回复内容'): AgentConverseUseCase {
  return {
    execute: vi.fn(async (input) => ok({
      conversationId: input.conversationId,
      reply,
      executionId: `exec-${input.clientRequestId}`,
      status: 'succeeded',
    })),
  } as unknown as AgentConverseUseCase;
}

describe('clientRequestId 派生（幂等键）', () => {
  it('有 botId → wechat:<botId>:<externalMessageId>；无 botId → wechat:<externalMessageId>', () => {
    expect(deriveClientRequestId('msg-1', 'bot-1')).toBe('wechat:bot-1:msg-1');
    expect(deriveClientRequestId('msg-1', null)).toBe('wechat:msg-1');
    expect(deriveClientRequestId('msg-1', undefined)).toBe('wechat:msg-1');
  });

  it('同一 externalMessageId 派生稳定（agent-converse claim 幂等前提）', () => {
    expect(deriveClientRequestId('msg-x', 'bot-9')).toBe(deriveClientRequestId('msg-x', 'bot-9'));
  });
});

describe('出站发送占位（持久幂等）', () => {
  it('并发重放只能有一个 claimed，完成后返回 sent，载荷变化被拒绝', async () => {
    const service = createChannelMessageService({ prisma });
    const input = {
      channel: 'wechat', teacherId: 'teacher-outbound', correlationId: `claim-${randomBytes(6).toString('hex')}`,
      chunkIndex: 0, fromExternalUserId: 'bot', toExternalUserId: 'wx-target', contentText: '唯一回复',
    };
    const first = await service.claimOutbound(input);
    expect(first.ok && first.value.state).toBe('claimed');
    const duplicate = await service.claimOutbound(input);
    expect(duplicate.ok && duplicate.value.state).toBe('uncertain');
    if (!first.ok) return;
    const completed = await service.completeOutbound({
      id: first.value.row.id, status: 'sent', processedAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(completed.ok && completed.value.status).toBe('sent');
    const replay = await service.claimOutbound(input);
    expect(replay.ok && replay.value.state).toBe('sent');
    const conflict = await service.claimOutbound({ ...input, contentText: '不同回复' });
    expect(conflict.ok).toBe(false);
  });
});

describe('createWechatConversationResolver（S5 多会话映射）', () => {
  function resolverDeps(overrides: {
    found?: { conversationId: string; runtimeOwner?: string } | null;
    createConversationId?: string;
    recordedConversationId?: string;
    runtimeOwner?: 'legacy' | 'dsh-v1';
  } = {}) {
    const conversationService = {
      createConversation: vi.fn(async () => ok({ id: overrides.createConversationId ?? 'conv-new' })),
    } as unknown as ConversationService;
    const channelConversations = {
      findMapping: vi.fn(async () => ok(overrides.found
        ? { id: 'cc-1', runtimeOwner: overrides.found.runtimeOwner ?? 'legacy', ...overrides.found }
        : null)),
      recordMapping: vi.fn(async (input: { conversationId: string }) => ok({
        id: 'cc-1', conversationId: overrides.recordedConversationId ?? input.conversationId,
      })),
      replaceMappingRuntime: vi.fn(async (input: { conversationId: string }) => ok({
        id: 'cc-1', conversationId: input.conversationId,
      })),
      touchLastMessage: vi.fn(async () => ok({ id: 'cc-1' })),
    };
    const clock = { now: vi.fn(async () => ok(new Date('2030-01-01T00:00:00.000Z'))) };
    const resolver = createWechatConversationResolver({
      conversationService, channelConversations, clock, runtimeOwner: overrides.runtimeOwner,
    });
    return { resolver, conversationService, channelConversations };
  }

  it('映射命中 → 复用既有平台 Conversation（不创建，touch lastMessageAtTs）', async () => {
    const { resolver, conversationService, channelConversations } = resolverDeps({ found: { conversationId: 'conv-existing' } });
    const result = await resolver.resolveForMessage({ teacherId: 't-1', externalConversationId: 'wx-sender-a' });
    expect(result.ok && result.value).toBe('conv-existing');
    expect(conversationService.createConversation).not.toHaveBeenCalled();
    expect(channelConversations.touchLastMessage).toHaveBeenCalledTimes(1);
  });

  it('映射未命中 → 创建平台 Conversation + 记录映射（含 lastMessageAt）', async () => {
    const { resolver, conversationService, channelConversations } = resolverDeps();
    const result = await resolver.resolveForMessage({ teacherId: 't-1', externalConversationId: 'wx-sender-b' });
    expect(result.ok && result.value).toBe('conv-new');
    expect(conversationService.createConversation).toHaveBeenCalledWith({ teacherId: 't-1' });
    expect(channelConversations.recordMapping).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'wechat',
      teacherId: 't-1',
      externalConversationId: 'wx-sender-b',
      conversationId: 'conv-new',
    }));
  });

  it('不同外部会话 → 各自解析（多会话独立；同一发送方幂等复用）', async () => {
    const { resolver, conversationService } = resolverDeps();
    // 同一 resolver 实例：两个发送方第一次都未命中 → 各自创建
    const a = await resolver.resolveForMessage({ teacherId: 't-1', externalConversationId: 'wx-a' });
    const b = await resolver.resolveForMessage({ teacherId: 't-1', externalConversationId: 'wx-b' });
    expect(a.ok && a.value).toBe('conv-new');
    expect(b.ok && b.value).toBe('conv-new');
    expect(conversationService.createConversation).toHaveBeenCalledTimes(2);
  });

  it('并发首次建映射冲突时跟随已持久化映射，不返回落败方孤立会话', async () => {
    const { resolver } = resolverDeps({
      createConversationId: 'conv-created-by-loser',
      recordedConversationId: 'conv-selected-by-mapping',
    });
    const result = await resolver.resolveForMessage({ teacherId: 't-1', externalConversationId: 'wx-race' });
    expect(result.ok && result.value).toBe('conv-selected-by-mapping');
  });

  it('DSH 装配命中 legacy 映射时创建新会话并原子换绑，保留旧会话引用', async () => {
    const { resolver, channelConversations } = resolverDeps({
      found: { conversationId: 'conv-legacy', runtimeOwner: 'legacy' },
      createConversationId: 'conv-dsh',
      runtimeOwner: 'dsh-v1',
    });
    const result = await resolver.resolveForMessage({ teacherId: 't-1', externalConversationId: 'wx-legacy' });
    expect(result.ok && result.value).toBe('conv-dsh');
    expect(channelConversations.replaceMappingRuntime).toHaveBeenCalledWith(expect.objectContaining({
      expectedConversationId: 'conv-legacy', expectedRuntimeOwner: 'legacy',
      conversationId: 'conv-dsh', runtimeOwner: 'dsh-v1',
    }));
  });
});

describe('agent loop（会话解析 + agent-converse 幂等触发）', () => {
  it('execute：以派生 clientRequestId 调用 agent-converse，返回 reply', async () => {
    const agentConverse = fakeAgentConverse('你好，明天有三节课');
    const conversationResolver = {
      resolveForMessage: vi.fn(async () => ok('conv-1')),
    };
    const loop = createWechatAgentLoop({ agentConverse, conversationResolver });
    const result = await loop.execute({
      teacherId: 't-1',
      message: message('msg-1', 'wx-1', '明天有什么课'),
      botId: 'bot-1',
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.reply : null).toBe('你好，明天有三节课');
    expect(agentConverse.execute).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 't-1',
      conversationId: 'conv-1',
      clientRequestId: 'wechat:bot-1:msg-1',
    }));
  });

  it('runInTeacherContext 包裹执行（装配线教师库上下文注入点）', async () => {
    const agentConverse = fakeAgentConverse('ok');
    const loop = createWechatAgentLoop({
      agentConverse,
      conversationResolver: { resolveForMessage: vi.fn(async () => ok('conv-1')) },
      runInTeacherContext: async (teacherId, fn) => {
        expect(teacherId).toBe('t-9');
        return fn();
      },
    });
    const result = await loop.execute({ teacherId: 't-9', message: message('m9', 'wx-9', 'hi'), botId: null });
    expect(result.ok).toBe(true);
  });
});

describe('入站 → Agent → 回复 全链路（真实队列 + mock agent/真实 outbound 分片）', () => {
  it('绑定教师消息：Agent 触发一次（clientRequestId 幂等）→ 分片回复 → outbound 落表 → processed', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s3-full', 'bot-s3');

    const agentConverse = fakeAgentConverse('短回复');
    const conversationResolver = { resolveForMessage: vi.fn(async () => ok('conv-full')) };
    const agentLoop = createWechatAgentLoop({ agentConverse, conversationResolver });
    const adapter = fakeAdapter();
    const clock = createDatabaseTrustedClock(prisma);
    const channelMessageService = createChannelMessageService({ prisma });
    const identityService = createChannelIdentityService({ prisma });
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const outbound = createWechatOutboundSender({
      channelMessageService,
      adapter,
      clock,
      maxTextLength: 1500,
    });
    const inboundService = createInboundMessageService({
      channelMessageService,
      identityService,
      queue,
      clock,
      agentLoop,
      outbound,
    });

    const msg = message('s3-full-1', 'wx-s3-full', '帮我看看明天的课');
    const received = await inboundService.receiveWebhook(msg);
    expect(received.ok).toBe(true);

    const result = await inboundService.processMessage(msg);
    expect(result.ok ? result.value.status : '').toBe('processed');

    // Agent 触发一次 + clientRequestId 派生正确
    expect(agentConverse.execute).toHaveBeenCalledTimes(1);
    expect(agentConverse.execute).toHaveBeenCalledWith(expect.objectContaining({
      teacherId,
      clientRequestId: 'wechat:bot-s3:s3-full-1',
    }));

    // 出站：adapter 收到回复，outbound 行落表
    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]).toEqual({ to: 'wx-s3-full', content: '短回复' });
    const outboundRows = await prisma.channelMessage.findMany({
      where: { externalMessageId: { startsWith: 'out:s3-full-1:' } },
    });
    expect(outboundRows).toHaveLength(1);
    expect(outboundRows[0].direction).toBe('outbound');
    expect(outboundRows[0].status).toBe('sent');
    expect(outboundRows[0].toExternalUserId).toBe('wx-s3-full');

    // 入站行：processed + teacherId + processedAtTs（TrustedClock）
    const inboundRow = await prisma.channelMessage.findUnique({
      where: { channel_externalMessageId: { channel: 'wechat', externalMessageId: 's3-full-1' } },
    });
    expect(inboundRow).not.toBeNull();
    expect(inboundRow!.status).toBe('processed');
    expect(inboundRow!.teacherId).toBe(teacherId);
    expect(inboundRow!.processedAtTs).not.toBeNull();
  });

  it('幂等：同 externalMessageId 二次 processMessage → already，Agent 不重复触发', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s3-idem', 'bot-idem');
    const agentConverse = fakeAgentConverse('ok');
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const clock = createDatabaseTrustedClock(prisma);
    const channelMessageService = createChannelMessageService({ prisma });
    const inboundService = createInboundMessageService({
      channelMessageService,
      identityService: createChannelIdentityService({ prisma }),
      queue,
      clock,
      agentLoop: createWechatAgentLoop({
        agentConverse,
        conversationResolver: { resolveForMessage: vi.fn(async () => ok('conv-idem')) },
      }),
      outbound: createWechatOutboundSender({
        channelMessageService,
        adapter: fakeAdapter(),
        clock,
      }),
    });

    const msg = message('s3-idem-1', 'wx-s3-idem', 'hi');
    await inboundService.receiveWebhook(msg);
    const first = await inboundService.processMessage(msg);
    expect(first.ok ? first.value.status : '').toBe('processed');
    const second = await inboundService.processMessage(msg);
    expect(second.ok ? second.value.status : '').toBe('already');
    expect(agentConverse.execute).toHaveBeenCalledTimes(1); // 只触发 1 次 Agent
  });

  it('长回复 → 分片 [1/2] + 出站多行落表', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s3-long', 'bot-long');
    const longReply = `${'a'.repeat(1800)}\n${'b'.repeat(400)}`;
    const agentConverse = fakeAgentConverse(longReply);
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const clock = createDatabaseTrustedClock(prisma);
    const channelMessageService = createChannelMessageService({ prisma });
    const adapter = fakeAdapter();
    const inboundService = createInboundMessageService({
      channelMessageService,
      identityService: createChannelIdentityService({ prisma }),
      queue,
      clock,
      agentLoop: createWechatAgentLoop({
        agentConverse,
        conversationResolver: { resolveForMessage: vi.fn(async () => ok('conv-long')) },
      }),
      outbound: createWechatOutboundSender({ channelMessageService, adapter, clock, maxTextLength: 1500 }),
    });

    const msg = message('s3-long-1', 'wx-s3-long', 'hi');
    await inboundService.receiveWebhook(msg);
    const result = await inboundService.processMessage(msg);
    expect(result.ok ? result.value.status : '').toBe('processed');

    expect(adapter.sends).toHaveLength(2);
    expect(adapter.sends[0].content.startsWith('[1/2]')).toBe(true);
    expect(adapter.sends[1].content.startsWith('[2/2]')).toBe(true);
    const outboundRows = await prisma.channelMessage.findMany({
      where: { externalMessageId: { startsWith: 'out:s3-long-1:' } },
      orderBy: { externalMessageId: 'asc' },
    });
    expect(outboundRows).toHaveLength(2);
    expect(outboundRows.every((r) => r.direction === 'outbound' && r.status === 'sent')).toBe(true);
  });

  it('Agent 失败 → status=failed + errorMsg；重试成功 → processed（幂等键防重复）', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s3-fail', 'bot-fail');
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const clock = createDatabaseTrustedClock(prisma);
    const channelMessageService = createChannelMessageService({ prisma });

    const failing: AgentConverseUseCase = {
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'INTERNAL_ERROR' as const, message: '模型调用失败' } })),
    } as unknown as AgentConverseUseCase;

    const inboundService = createInboundMessageService({
      channelMessageService,
      identityService: createChannelIdentityService({ prisma }),
      queue,
      clock,
      agentLoop: createWechatAgentLoop({
        agentConverse: failing,
        conversationResolver: { resolveForMessage: vi.fn(async () => ok('conv-fail')) },
      }),
    });

    const msg = message('s3-fail-1', 'wx-s3-fail', 'hi');
    await inboundService.receiveWebhook(msg);
    const failed = await inboundService.processMessage(msg);
    expect(failed.ok ? failed.value.status : '').toBe('failed');
    const row = await prisma.channelMessage.findUnique({
      where: { channel_externalMessageId: { channel: 'wechat', externalMessageId: 's3-fail-1' } },
    });
    expect(row!.status).toBe('failed');
    expect(row!.errorMsg).toContain('模型调用失败');
  });
});

describe('未绑定恢复扫描', () => {
  it('未绑定挂起 → 扫描保持 new；绑定后 → 扫描重试入队（recovered）；超时未绑 → failed（failedStale）', async () => {
    const teacherId = await createTeacher();
    const clock = createDatabaseTrustedClock(prisma);
    const channelMessageService = createChannelMessageService({ prisma });
    const identityService = createChannelIdentityService({ prisma });
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const scanner = createWechatUnboundRecoveryScanner({
      channelMessageService,
      identityService,
      queue,
      clock,
      intervalMs: 60_000,
      maxPendingMs: 60 * 60 * 1000,
    });

    // 未绑定消息 1（将绑定）与消息 2（将超时）
    const msg1 = message('s3-rec-1', 'wx-rec-1', 'hi');
    const msg2 = message('s3-rec-2', 'wx-rec-2', 'hi');
    await channelMessageService.claim({
      channel: 'wechat', externalMessageId: msg1.externalMessageId,
      fromExternalUserId: msg1.fromExternalUserId, contentText: msg1.text,
    });
    await channelMessageService.claim({
      channel: 'wechat', externalMessageId: msg2.externalMessageId,
      fromExternalUserId: msg2.fromExternalUserId, contentText: msg2.text,
    });
    // 消息 2 改为历史时间（超 maxPendingMs）
    await prisma.channelMessage.updateMany({
      where: { externalMessageId: 's3-rec-2' },
      data: { createdAtTs: new Date('2020-01-01T00:00:00.000Z') },
    });

    // 首次扫描：均未绑定 → 无恢复、无超时（消息2 已超时 → 置 failed）
    let scan = await scanner.scanOnce();
    expect(scan.ok ? scan.value : null).toEqual({ recovered: 0, failedStale: 1 });
    const row2 = await channelMessageService.getByExternalMessageId('wechat', 's3-rec-2');
    expect(row2.ok ? row2.value!.status : '').toBe('failed');
    expect(row2.ok ? row2.value!.errorMsg : '').toBe('未绑定超时');

    // 绑定后扫描：消息1 恢复入队
    await bindTeacher(teacherId, 'wx-rec-1', 'bot-rec');
    scan = await scanner.scanOnce();
    expect(scan.ok ? scan.value : null).toEqual({ recovered: 1, failedStale: 0 });
    const row1 = await channelMessageService.getByExternalMessageId('wechat', 's3-rec-1');
    expect(row1.ok ? row1.value!.status : '').toBe('queued');
    expect(queue.size()).toBe(1); // 已入队等待 worker 处理
  });

  it('channelMessageRowToInbound 重建标准化消息（恢复入队载荷）', () => {
    const rebuilt = channelMessageRowToInbound({
      channel: 'wechat',
      externalMessageId: 'm-1',
      fromExternalUserId: 'wx-1',
      toExternalUserId: 'bot-1',
      contentText: '你好',
    });
    expect(rebuilt).toEqual({
      channel: 'wechat',
      externalMessageId: 'm-1',
      fromExternalUserId: 'wx-1',
      toExternalUserId: 'bot-1',
      conversationType: 'private',
      messageType: 'text',
      text: '你好',
    });
  });
});
