import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createConversationService } from '../../../src/features/conversation/index.js';
import {
  computeWechatSignature,
  createChannelConversationService,
  createChannelMessageService,
  createLoginStateStore,
  createWechatConversationResolver,
  createWechatLoginRouter,
  createWechatMessageRouter,
  WECHAT_PLATFORM,
  type ChannelConversationService,
  type InboundMessageService,
  type WechatIlinkConfig,
} from '../../../src/features/wechat/index.js';

/**
 * P8 t23 S5 加固测试：
 * 1. ChannelConversation 多会话映射（真实 DB：一教师多发送方各自独立平台 Conversation，同发送方幂等复用）；
 * 2. webhook 超时保护（处理挂起 → 503 背压，微信 5s 硬约束防线）；
 * 3. 重放防护四层复核（timestamp/signature/state/幂等键——端到端断言无漏）。
 * IP 白名单细化决策：保持平台级（设计 §9「保持平台级」分支）——iLink 主传输为出站长轮询（无回调 IP），
 * 公众号/SaaS webhook 形态的 IP 面在 W0 协议冻结后按供应商文档录入平台级 WECHAT_ILINK_ALLOWED_IPS。
 */

const prisma = new PrismaClient();

const TOKEN = 'wechat-s5-token';
const BASE_CONFIG: WechatIlinkConfig = {
  enabled: true,
  appid: 's5-appid',
  appSecret: 's5-secret',
  token: TOKEN,
  apiBaseUrl: 'https://ilinkai.weixin.qq.com',
  allowedIps: ['127.0.0.1'],
  stateTtlMs: 5 * 60 * 1000,
  timestampWindowMs: 5 * 60 * 1000,
  qrcodeRatePerMin: 200,
  callbackRatePerMin: 200,
  bindRatePerMin: 200,
  inboundPerMin: 200,
  notifyRatePerMin: 60,
  maxTextLength: 1500,
  recoveryIntervalMs: 60_000,
  unboundMaxPendingMs: 24 * 60 * 60 * 1000,
  webhookTimeoutMs: 4000,
  maxStateKeys: 1000,
  botToken: 'test-bot-token',
  longPollTimeoutMs: 40_000,
  pollBackoffMs: [2000, 5000, 30_000],
  maxConsecutivePollFailures: 3,
  contextTokenTtlMs: 24 * 60 * 60 * 1000,
  outboundTimeoutMs: 15_000,
};

const createdTeacherIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  await prisma.channelMessage.deleteMany({});
  await prisma.channelConversation.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.channelIdentity.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.conversationTurn.deleteMany({ where: { conversationId: { in: createdConversationIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

async function createTeacher(): Promise<string> {
  const teacher = await prisma.teacherRegistry.create({
    data: { email: `wx-s5-${randomBytes(6).toString('hex')}@example.com`, passwordHash: 'scrypt$test$test', displayName: 'S5 测试教师' },
  });
  createdTeacherIds.push(teacher.id);
  return teacher.id;
}

describe('ChannelConversation 多会话映射（真实 DB）', () => {
  it('一教师多发送方 → 各自独立平台 Conversation；同发送方幂等复用；touch lastMessageAtTs', async () => {
    const teacherId = await createTeacher();
    await prisma.channelIdentity.create({
      data: { teacherId, platform: WECHAT_PLATFORM, externalUserId: 'wx-s5-sender', providerChannelId: 'bot-s5' },
    });
    const channelConversations: ChannelConversationService = createChannelConversationService({ prisma });
    const resolver = createWechatConversationResolver({
      conversationService: createConversationService({ prisma }),
      channelConversations,
      clock: createDatabaseTrustedClock(prisma),
    });

    // 发送方 A 首次 → 创建平台 Conversation + 映射
    const a1 = await resolver.resolveForMessage({ teacherId, externalConversationId: 'wx-sender-a' });
    expect(a1.ok).toBe(true);
    const convA = a1.ok ? a1.value : null;
    expect(convA).not.toBeNull();
    createdConversationIds.push(convA!);

    // 发送方 B 首次 → 独立平台 Conversation（多会话）
    const b1 = await resolver.resolveForMessage({ teacherId, externalConversationId: 'wx-sender-b' });
    expect(b1.ok && b1.value).not.toBe(convA);
    createdConversationIds.push(b1.ok ? b1.value! : '');

    // 发送方 A 再次 → 复用同一 Conversation（幂等映射）
    const a2 = await resolver.resolveForMessage({ teacherId, externalConversationId: 'wx-sender-a' });
    expect(a2.ok && a2.value).toBe(convA);

    // 映射行：2 条（A/B 各自）
    const mappings = await prisma.channelConversation.findMany({ where: { teacherId } });
    expect(mappings).toHaveLength(2);
    const mappingA = mappings.find((m) => m.externalConversationId === 'wx-sender-a');
    expect(mappingA).not.toBeUndefined();
    expect(mappingA!.conversationId).toBe(convA);
    expect(mappingA!.lastMessageAtTs).not.toBeNull(); // touch 写入（TrustedClock）
  });
});

describe('webhook 超时保护（S5 背压）', () => {
  it('处理挂起超过 webhookTimeoutMs → 503（微信 5s 硬约束防线）', async () => {
    const hanging: InboundMessageService = {
      receiveWebhook: vi.fn(async () => new Promise(() => undefined)), // 永不 resolve
      processMessage: vi.fn(async () => ({ ok: true as const, value: { status: 'processed' as const } })),
    };
    const router = createWechatMessageRouter({
      config: { ...BASE_CONFIG, webhookTimeoutMs: 50 },
      inboundService: hanging,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(8).toString('hex');
    const signature = computeWechatSignature({ token: TOKEN, timestamp, nonce });
    const res = await request(app)
      .post('/api/v1/wechat/message')
      .send({
        externalMessageId: 's5-timeout-1',
        fromExternalUserId: 'wx-timeout',
        conversationType: 'private',
        messageType: 'text',
        text: 'hi',
        timestamp,
        nonce,
        signature,
      });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('正常处理不受超时保护影响（50ms 内完成 → 200）', async () => {
    const router = createWechatMessageRouter({
      config: { ...BASE_CONFIG, webhookTimeoutMs: 50 },
      inboundService: {
        receiveWebhook: vi.fn(async () => ({ ok: true as const, value: { accepted: true, duplicate: false } })),
        processMessage: vi.fn(async () => ({ ok: true as const, value: { status: 'processed' as const } })),
      } as unknown as InboundMessageService,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(8).toString('hex');
    const signature = computeWechatSignature({ token: TOKEN, timestamp, nonce });
    const res = await request(app).post('/api/v1/wechat/message').send({
      externalMessageId: 's5-ok-1',
      fromExternalUserId: 'wx-ok',
      conversationType: 'private',
      messageType: 'text',
      text: 'hi',
      timestamp,
      nonce,
      signature,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(true);
  });
});

describe('重放防护四层复核（timestamp / signature / state / 幂等键）', () => {
  it('第一层 timestamp：±5min 外 → 静默拒绝（消息与回调同规则）', async () => {
    const router = createWechatMessageRouter({
      config: BASE_CONFIG,
      inboundService: {
        receiveWebhook: vi.fn(async () => ({ ok: true as const, value: { accepted: true, duplicate: false } })),
        processMessage: vi.fn(async () => ({ ok: true as const, value: { status: 'processed' as const } })),
      } as unknown as InboundMessageService,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    // 10 分钟前的时间戳（签名随旧时间戳计算——超窗判定在验签之前）
    const stale = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    const timestamp = String(stale);
    const nonce = randomBytes(8).toString('hex');
    const signature = computeWechatSignature({ token: TOKEN, timestamp, nonce });
    const res = await request(app).post('/api/v1/wechat/message').send({
      externalMessageId: 's5-stale-1',
      fromExternalUserId: 'wx-stale',
      conversationType: 'private',
      messageType: 'text',
      text: 'hi',
      timestamp,
      nonce,
      signature,
    });
    expect(res.body.data.accepted).toBe(false); // 静默丢弃
  });

  it('第二层 signature：篡改签名 → 静默拒绝（timingSafeEqual）', async () => {
    const router = createWechatMessageRouter({
      config: BASE_CONFIG,
      inboundService: {
        receiveWebhook: vi.fn(async () => ({ ok: true as const, value: { accepted: true, duplicate: false } })),
        processMessage: vi.fn(async () => ({ ok: true as const, value: { status: 'processed' as const } })),
      } as unknown as InboundMessageService,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(8).toString('hex');
    const res = await request(app).post('/api/v1/wechat/message').send({
      externalMessageId: 's5-sig-1',
      fromExternalUserId: 'wx-sig',
      conversationType: 'private',
      messageType: 'text',
      text: 'hi',
      timestamp,
      nonce,
      signature: 'deadbeef',
    });
    expect(res.body.data.accepted).toBe(false);
  });

  it('第三层 state：登录回调同一 state 二次消费被状态机拒绝（一次性）', async () => {
    const authService = { validateToken: vi.fn(async () => ({ ok: false as const, error: { code: 'PERMISSION_DENIED' as const, message: 'x' } })) };
    const identityService = {
      bind: vi.fn(async () => ({ ok: true as const, value: { id: 'ci-1' } })),
      unbind: vi.fn(async () => ({ ok: true as const, value: { unbound: true } })),
      resolveTeacherId: vi.fn(async () => ({ ok: true as const, value: null })),
      resolveChannelBinding: vi.fn(async () => ({ ok: true as const, value: null })),
      listByTeacher: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    const stateStore = createLoginStateStore({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
    const router = createWechatLoginRouter({
      authService: authService as never,
      channelIdentityService: identityService as never,
      stateStore,
      config: BASE_CONFIG,
      codeExchanger: {
        exchange: vi.fn(async () => ({
          ok: true as const,
          value: { externalUserId: 'wx-login', providerChannelId: 'bot-login' },
        })),
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const state = qr.body.data.state as string;

    // 第一次回调：accepted（state pending → confirmed）
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(8).toString('hex');
    const sig = computeWechatSignature({ token: TOKEN, timestamp: ts, nonce });
    const first = await request(app).post('/api/v1/auth/wechat/callback').send({ state, code: 'c1', timestamp: ts, nonce, signature: sig });
    expect(first.body.data.accepted).toBe(true);

    // 同一 state 二次回调（重放）：状态机拒绝（已 confirmed，非 pending）
    const ts2 = String(Math.floor(Date.now() / 1000));
    const nonce2 = randomBytes(8).toString('hex');
    const sig2 = computeWechatSignature({ token: TOKEN, timestamp: ts2, nonce: nonce2 });
    const second = await request(app).post('/api/v1/auth/wechat/callback').send({ state, code: 'c2', timestamp: ts2, nonce: nonce2, signature: sig2 });
    expect(second.body.data.accepted).toBe(false);
  });

  it('第四层 幂等键：同 externalMessageId 双投递只 1 行（ChannelMessage unique 持久层）', async () => {
    const channelMessageService = createChannelMessageService({ prisma });
    const externalMessageId = `s5-dedup-${randomBytes(4).toString('hex')}`;
    const first = await channelMessageService.claim({
      channel: 'wechat',
      externalMessageId,
      fromExternalUserId: 'wx-dedup',
      contentText: 'hi',
    });
    expect(first.ok && first.value.duplicate).toBe(false);
    const second = await channelMessageService.claim({
      channel: 'wechat',
      externalMessageId,
      fromExternalUserId: 'wx-dedup',
      contentText: 'hi',
    });
    expect(second.ok && second.value.duplicate).toBe(true);
    const count = await prisma.channelMessage.count({ where: { externalMessageId } });
    expect(count).toBe(1);
  });
});
