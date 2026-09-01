import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { RateLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import {
  computeWechatSignature,
  createChannelIdentityService,
  createChannelMessageService,
  createInboundMessageService,
  createInMemoryMessageQueue,
  createWechatMessageRouter,
  WECHAT_PLATFORM,
  type ChannelIdentityService,
  type InboundMessageService,
  type QueuePort,
  type WechatIlinkConfig,
} from '../../../src/features/wechat/index.js';

const prisma = new PrismaClient();

const TOKEN = 'wechat-ilink-msg-token';
const BASE_CONFIG: WechatIlinkConfig = {
  enabled: true,
  appid: 'test-appid',
  appSecret: 'test-secret',
  token: TOKEN,
  apiBaseUrl: 'https://ilinkai.weixin.qq.com',
  allowedIps: ['127.0.0.1'],
  stateTtlMs: 5 * 60 * 1000,
  timestampWindowMs: 5 * 60 * 1000,
  qrcodeRatePerMin: 200,
  callbackRatePerMin: 200,
  bindRatePerMin: 200,
  inboundPerMin: 200,
  notifyRatePerMin: 200,
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

interface BuildOptions {
  config?: Partial<WechatIlinkConfig>;
  limiter?: RateLimiter;
  queue?: QueuePort;
  resolveRequestIp?: (req: express.Request) => string | null;
  nowMs?: () => number;
}

function buildInbound(options: BuildOptions = {}) {
  const config = { ...BASE_CONFIG, ...options.config };
  const identityService: ChannelIdentityService = createChannelIdentityService({ prisma });
  const messageService = createChannelMessageService({ prisma });
  const queue = options.queue ?? createInMemoryMessageQueue({ maxSize: 1000 });
  const inboundService: InboundMessageService = createInboundMessageService({
    channelMessageService: messageService,
    identityService,
    queue,
    clock: createDatabaseTrustedClock(prisma),
  });
  const router = createWechatMessageRouter({
    config,
    inboundService,
    limiter: options.limiter,
    resolveRequestIp: options.resolveRequestIp,
    nowMs: options.nowMs,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return { app, inboundService, queue, identityService, messageService };
}

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.channelMessage.deleteMany({});
  await prisma.channelIdentity.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function uniqueEmail(): string {
  return `wx-msg-${randomBytes(6).toString('hex')}@example.com`;
}

async function createTeacher(): Promise<string> {
  const teacher = await prisma.teacherRegistry.create({
    data: {
      email: uniqueEmail(),
      passwordHash: 'scrypt$test$test',
      displayName: '入站消息测试教师',
    },
  });
  createdTeacherIds.push(teacher.id);
  return teacher.id;
}

function signedFields(nowMsValue = Date.now()): { timestamp: string; nonce: string; signature: string } {
  const timestamp = String(Math.floor(nowMsValue / 1000));
  const nonce = randomBytes(8).toString('hex');
  const signature = computeWechatSignature({ token: TOKEN, timestamp, nonce });
  return { timestamp, nonce, signature };
}

function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalMessageId: `msg-${randomBytes(6).toString('hex')}`,
    fromExternalUserId: 'wx-sender-default',
    conversationType: 'private',
    messageType: 'text',
    text: '你好，帮我看看明天的课程',
    ...signedFields(),
    ...overrides,
  };
}

async function postMessage(app: express.Express, body: Record<string, unknown>) {
  return request(app).post('/api/v1/wechat/message').send(body);
}

describe('webhook 验签 / 白名单 / 静默丢弃', () => {
  it('验签成功 → 200 accepted:true + 落库 1 行 status=queued', async () => {
    const { app, messageService } = buildInbound();
    const body = messageBody({ fromExternalUserId: 'wx-verify-ok' });
    const res = await postMessage(app, body);
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(true);
    expect(res.body.data.duplicate).toBe(false);

    const row = await messageService.getByExternalMessageId('wechat', body.externalMessageId as string);
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    expect(row.value).toMatchObject({
      status: 'queued',
      channel: 'wechat',
      fromExternalUserId: 'wx-verify-ok',
      contentText: '你好，帮我看看明天的课程',
      teacherId: null,
    });
    expect(row.value.processedAtTs).toBeNull();
  });

  it('错误签名 → accepted:false（静默丢弃，不落库）', async () => {
    const { app, messageService } = buildInbound();
    const body = messageBody();
    const res = await postMessage(app, { ...body, signature: 'deadbeef' });
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(false);
    const row = await messageService.getByExternalMessageId('wechat', body.externalMessageId as string);
    expect(row.ok && row.value).toBeNull();
  });

  it('timestamp 超窗（±5min 外）→ accepted:false', async () => {
    const { app } = buildInbound();
    // 以过期时间生成签名（10 分钟前）
    const body = messageBody({ ...signedFields(Date.now() - 10 * 60 * 1000) });
    const res = await postMessage(app, body);
    expect(res.body.data.accepted).toBe(false);
  });

  it('缺 timestamp/nonce/signature → accepted:false', async () => {
    const { app } = buildInbound();
    const res = await postMessage(app, { externalMessageId: 'm1', text: 'hi' });
    expect(res.body.data.accepted).toBe(false);
  });

  it('IP 白名单：非白名单 IP → accepted:false', async () => {
    const { app } = buildInbound({ resolveRequestIp: () => '203.0.113.9' });
    const res = await postMessage(app, messageBody());
    expect(res.body.data.accepted).toBe(false);
  });

  it('IP 白名单：空白名单（未配置）→ fail-closed 全拒', async () => {
    const { app } = buildInbound({ config: { allowedIps: [] }, resolveRequestIp: () => '127.0.0.1' });
    const res = await postMessage(app, messageBody());
    expect(res.body.data.accepted).toBe(false);
  });

  it('malformed body（缺 text / 非 text 类型）→ accepted:false', async () => {
    const { app } = buildInbound();
    const noText = await postMessage(app, messageBody({ text: '' }));
    expect(noText.body.data.accepted).toBe(false);
    const unsupported = await postMessage(app, messageBody({ messageType: 'voice' }));
    expect(unsupported.body.data.accepted).toBe(false);
  });
});

describe('持久幂等：同一 externalMessageId 重投去重', () => {
  it('双投递只 1 行（第二次 duplicate:true），不重复入队', async () => {
    const { app, queue } = buildInbound();
    const body = messageBody({ fromExternalUserId: 'wx-dedup' });
    const externalMessageId = body.externalMessageId as string;

    const first = await postMessage(app, body);
    expect(first.body.data.accepted).toBe(true);
    expect(first.body.data.duplicate).toBe(false);
    expect(queue.size()).toBe(1);

    const second = await postMessage(app, body);
    expect(second.status).toBe(200);
    expect(second.body.data.accepted).toBe(true);
    expect(second.body.data.duplicate).toBe(true);
    expect(queue.size()).toBe(1); // 未重复入队

    const count = await prisma.channelMessage.count({ where: { externalMessageId } });
    expect(count).toBe(1);

    // 手动触发 worker（S2 无 Agent）：已绑定场景处理一次
    const processed = await prisma.channelMessage.findFirst({ where: { externalMessageId } });
    expect(processed).not.toBeNull();
  });
});

describe('限流（复用 RateLimiter）', () => {
  it('单用户入站 1min/2 → 第 3 条 429 + Retry-After + RATE_LIMITED', async () => {
    const limiter = createSlidingWindowLimiter({ maxKeys: 1000 });
    const { app } = buildInbound({ config: { inboundPerMin: 2 }, limiter });
    const first = await postMessage(app, messageBody({ fromExternalUserId: 'wx-limited' }));
    expect(first.status).toBe(200);
    const second = await postMessage(app, messageBody({ fromExternalUserId: 'wx-limited' }));
    expect(second.status).toBe(200);
    const third = await postMessage(app, messageBody({ fromExternalUserId: 'wx-limited' }));
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('不同发送方独立计数', async () => {
    const limiter = createSlidingWindowLimiter({ maxKeys: 1000 });
    const { app } = buildInbound({ config: { inboundPerMin: 1 }, limiter });
    const a = await postMessage(app, messageBody({ fromExternalUserId: 'wx-a' }));
    expect(a.status).toBe(200);
    const a2 = await postMessage(app, messageBody({ fromExternalUserId: 'wx-a' }));
    expect(a2.status).toBe(429);
    const b = await postMessage(app, messageBody({ fromExternalUserId: 'wx-b' }));
    expect(b.status).toBe(200); // B 独立计数
  });
});

describe('队列：进程内内存队列（QueuePort）', () => {
  it('队列满 → 503 + 消息标记 failed（供应商重试，持久幂等兜底）', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 1 });
    const { app, messageService } = buildInbound({ queue });
    // 第一条占满队列（worker 未启动 → 不消费）
    const first = await postMessage(app, messageBody({ fromExternalUserId: 'wx-full', externalMessageId: 'wx-full-1' }));
    expect(first.status).toBe(200);

    const second = await postMessage(app, messageBody({ fromExternalUserId: 'wx-full', externalMessageId: 'wx-full-2' }));
    expect(second.status).toBe(503);
    expect(second.body.ok).toBe(false);

    const row = await messageService.getByExternalMessageId('wechat', 'wx-full-2');
    expect(row.ok && row.value).not.toBeNull();
    expect(row.ok ? row.value!.status : '').toBe('failed');
  });
});

describe('Agent 闭环前置：未绑定挂起 / 绑定后解析（processMessage）', () => {
  it('未绑定消息 → status=new 挂起（不触发 Agent：teacherId/processedAtTs 均空）', async () => {
    const { app, inboundService, messageService } = buildInbound();
    const body = messageBody({ fromExternalUserId: 'wx-unbound-user' });
    await postMessage(app, body);

    const result = await inboundService.processMessage({
      channel: 'wechat',
      externalMessageId: body.externalMessageId as string,
      fromExternalUserId: 'wx-unbound-user',
      conversationType: 'private',
      messageType: 'text',
      text: body.text as string,
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.status : '').toBe('unbound');

    const row = await messageService.getByExternalMessageId('wechat', body.externalMessageId as string);
    expect(row.ok ? row.value!.status : '').toBe('new'); // 挂起
    expect(row.ok ? row.value!.teacherId : 'x').toBeNull();
    expect(row.ok ? row.value!.processedAtTs : new Date()).toBeNull();
  });

  it('已绑定 → status=processed + teacherId + processedAtTs（TrustedClock）', async () => {
    const { app, inboundService, messageService, identityService } = buildInbound();
    const teacherId = await createTeacher();
    const bind = await identityService.bind({
      teacherId,
      platform: WECHAT_PLATFORM,
      externalUserId: 'wx-bound-user',
    });
    expect(bind.ok).toBe(true);

    const body = messageBody({ fromExternalUserId: 'wx-bound-user' });
    await postMessage(app, body);

    const result = await inboundService.processMessage({
      channel: 'wechat',
      externalMessageId: body.externalMessageId as string,
      fromExternalUserId: 'wx-bound-user',
      conversationType: 'private',
      messageType: 'text',
      text: body.text as string,
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.status : '').toBe('processed');

    const row = await messageService.getByExternalMessageId('wechat', body.externalMessageId as string);
    expect(row.ok ? row.value!.status : '').toBe('processed');
    expect(row.ok ? row.value!.teacherId : null).toBe(teacherId);
    expect(row.ok ? row.value!.processedAtTs : null).not.toBeNull(); // TrustedClock 写入
  });

  it('已处理消息重放 → already（幂等，不重复处理）', async () => {
    const { inboundService, identityService } = buildInbound();
    const teacherId = await createTeacher();
    await identityService.bind({
      teacherId,
      platform: WECHAT_PLATFORM,
      externalUserId: 'wx-already',
    });
    const msg = {
      channel: 'wechat' as const,
      externalMessageId: 'wx-already-1',
      fromExternalUserId: 'wx-already',
      conversationType: 'private' as const,
      messageType: 'text' as const,
      text: 'hello',
    };
    const claim = await inboundService.receiveWebhook(msg);
    expect(claim.ok).toBe(true);
    const first = await inboundService.processMessage(msg);
    expect(first.ok ? first.value.status : '').toBe('processed');
    const second = await inboundService.processMessage(msg);
    expect(second.ok ? second.value.status : '').toBe('already');
  });
});
