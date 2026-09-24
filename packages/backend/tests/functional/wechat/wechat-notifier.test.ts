import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { afterAll } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import {
  createChannelIdentityService,
  createChannelMessageService,
  createWechatNotifier,
  createWechatPushRecipientResolver,
  parseWechatNotifyToolCall,
  WECHAT_NOTIFY_CHANNEL,
  WECHAT_NOTIFY_PLATFORM,
  WECHAT_PLATFORM,
  type ChannelIdentityService,
  type WechatNotifier,
  type WechatTextAdapter,
} from '../../../src/features/wechat/index.js';
import { createPushService } from '../../../src/features/push/index.js';
import type { MessageAdapter } from '../../../src/adapters/shared/index.js';

/**
 * S4 主动推送（P8 t21，设计 p7-wechat-ilink-design.md §4.6/§6/§7）：
 * - parseWechatNotifyToolCall：channels=["bridge_owner"] + bridgePlatforms=["wechat"] 缺一不可；
 * - createWechatNotifier.sendNotify：ChannelIdentity 解析外部 id → 出站落表 + adapter send；
 *   无绑定 skipped；逐片发送前持久占位；已 sent 重放不重发，失败/不确定状态停止自动重发；
 *   限流（RateLimiter 1min/N，RATE_LIMITED）；
 * - createWechatPushRecipientResolver（D37 §4.3）：wechat-bot 渠道 teacherId → wxid；无绑定 null；
 *   其它渠道原样 teacherId；
 * - pushService.sendPush + resolver：绑定 → 发外部 id；无绑定 → status='skipped' 不调 adapter。
 * 隔离库由 run-tests-isolated.mjs 创建并 drop；本文件只写共享表（不建 teacher_db_*）。
 */

const prisma = new PrismaClient();

const createdTeacherIds: string[] = [];
const createdIdentityIds: string[] = [];

afterAll(async () => {
  await prisma.channelIdentity.deleteMany({ where: { id: { in: createdIdentityIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.pushRecord.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.channelMessage.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function uniqueEmail(): string {
  return `wx-s4-${randomBytes(6).toString('hex')}@example.com`;
}

async function createTeacher(): Promise<string> {
  const teacher = await prisma.teacherRegistry.create({
    data: { email: uniqueEmail(), passwordHash: 'scrypt$test$test', displayName: 'S4 测试教师' },
  });
  createdTeacherIds.push(teacher.id);
  return teacher.id;
}

async function bindTeacher(teacherId: string, externalUserId: string): Promise<string> {
  const identity: ChannelIdentityService = createChannelIdentityService({ prisma });
  const result = await identity.bind({
    teacherId,
    platform: WECHAT_PLATFORM,
    externalUserId,
    providerChannelId: `bot-${externalUserId}`,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return '';
  createdIdentityIds.push(result.value.id);
  return result.value.externalUserId;
}

function fakeAdapter(okSend = true): WechatTextAdapter & { sends: Array<{ to: string; content: string }> } {
  const sends: Array<{ to: string; content: string }> = [];
  return {
    sends,
    async send(input) {
      sends.push(input);
      if (!okSend) {
        return { ok: false as const, error: { code: 'INTERNAL_ERROR' as const, message: 'transport 未就绪' } };
      }
      return ok({ messageId: `notify-${sends.length}` });
    },
  };
}

function notifierWith(adapter: WechatTextAdapter, overrides: Partial<Parameters<typeof createWechatNotifier>[0]> = {}): WechatNotifier {
  return createWechatNotifier({
    channelMessageService: createChannelMessageService({ prisma }),
    identityService: createChannelIdentityService({ prisma }),
    adapter,
    clock: createDatabaseTrustedClock(prisma),
    maxTextLength: 1500,
    ...overrides,
  });
}

describe('parseWechatNotifyToolCall（iLink notify 工具调用解析）', () => {
  it('channels=["bridge_owner"] + bridgePlatforms=["wechat"] → 通过', () => {
    const result = parseWechatNotifyToolCall({
      title: '今日课程提醒',
      body: '下午 3 点有课',
      channels: [WECHAT_NOTIFY_CHANNEL],
      bridgePlatforms: [WECHAT_NOTIFY_PLATFORM],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('今日课程提醒');
    expect(result.value.body).toBe('下午 3 点有课');
    expect(result.value.channels).toEqual(['bridge_owner']);
    expect(result.value.bridgePlatforms).toEqual(['wechat']);
  });

  it('缺 bridge_owner → VALIDATION_ERROR（缺一不可）', () => {
    const result = parseWechatNotifyToolCall({
      title: 't',
      body: 'b',
      channels: ['desktop'],
      bridgePlatforms: [WECHAT_NOTIFY_PLATFORM],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('channels');
  });

  it('缺 wechat → VALIDATION_ERROR（缺一不可）', () => {
    const result = parseWechatNotifyToolCall({
      title: 't',
      body: 'b',
      channels: [WECHAT_NOTIFY_CHANNEL],
      bridgePlatforms: ['feishu'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('bridgePlatforms');
  });

  it('非对象 / 缺 title/body / channels 非字符串数组 → VALIDATION_ERROR', () => {
    for (const payload of [
      'x',
      { body: 'b', channels: [WECHAT_NOTIFY_CHANNEL], bridgePlatforms: [WECHAT_NOTIFY_PLATFORM] },
      { title: 't', body: 'b', channels: 'x', bridgePlatforms: [WECHAT_NOTIFY_PLATFORM] },
      { title: 't', body: 'b', channels: [1], bridgePlatforms: [WECHAT_NOTIFY_PLATFORM] },
    ]) {
      const result = parseWechatNotifyToolCall(payload);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('createWechatNotifier.sendNotify（主动推送）', () => {
  it('绑定教师：ChannelIdentity 解析外部 id → adapter 收到 wxid → outbound 落表 status=sent', async () => {
    const teacherId = await createTeacher();
    const wxid = await bindTeacher(teacherId, 'wx-s4-send');

    const adapter = fakeAdapter();
    const notifier = notifierWith(adapter);
    const result = await notifier.sendNotify({
      teacherId,
      type: 'morning_brief',
      correlationId: `morning-brief:${teacherId}:2026-08-22`,
      content: '早安简报',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('sent');
    expect(result.value.sentChunks).toBe(1);
    expect(result.value.targetExternalUserId).toBe(wxid);
    expect(adapter.sends).toEqual([{ to: wxid, content: '早安简报' }]);

    const rows = await prisma.channelMessage.findMany({
      where: { externalMessageId: { startsWith: `out:notify:morning-brief:${teacherId}:2026-08-22:` } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('outbound');
    expect(rows[0].status).toBe('sent');
    expect(rows[0].toExternalUserId).toBe(wxid);
    expect(rows[0].teacherId).toBe(teacherId);
    expect(rows[0].processedAtTs).not.toBeNull(); // TrustedClock
  });

  it('未绑定教师 → skipped（不发送、不落表）', async () => {
    const teacherId = await createTeacher();
    const adapter = fakeAdapter();
    const notifier = notifierWith(adapter);
    const result = await notifier.sendNotify({
      teacherId,
      type: 'evening_review',
      correlationId: `evening:${teacherId}:2026-08-22`,
      content: '晚间复盘',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('skipped');
    expect(result.value.sentChunks).toBe(0);
    expect(adapter.sends).toHaveLength(0);
  });

  it('幂等重放：同 correlationId 首片已 sent → replayed，adapter 不重发', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s4-idem');

    const adapter = fakeAdapter();
    const notifier = notifierWith(adapter);
    const correlationId = `morning-brief:${teacherId}:2026-08-23`;
    const first = await notifier.sendNotify({ teacherId, type: 'morning_brief', correlationId, content: '内容 A' });
    expect(first.ok && first.value.status).toBe('sent');

    const replay = await notifier.sendNotify({ teacherId, type: 'morning_brief', correlationId, content: '内容 A' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.status).toBe('replayed');
    expect(adapter.sends).toHaveLength(1); // 只发一次
    expect(adapter.sends[0].content).toBe('内容 A');

    const conflict = await notifier.sendNotify({ teacherId, type: 'morning_brief', correlationId, content: '内容 B（不得覆盖）' });
    expect(conflict.ok).toBe(false);
    expect(adapter.sends).toHaveLength(1);
  });

  it('失败 → 返回错误 + outbound 落表 status=failed；自动重试被阻止以免重复发送', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s4-fail');

    const correlationId = `morning-brief:${teacherId}:2026-08-24`;
    const failing = fakeAdapter(false);
    const notifier1 = notifierWith(failing);
    const failed = await notifier1.sendNotify({ teacherId, type: 'morning_brief', correlationId, content: '会失败' });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe('INTERNAL_ERROR');

    const failRow = await prisma.channelMessage.findFirst({
      where: { externalMessageId: `out:notify:${correlationId}:0` },
    });
    expect(failRow).not.toBeNull();
    expect(failRow!.status).toBe('failed');
    expect(failRow!.errorMsg).toContain('transport 未就绪');

    // 重试：远端是否收到无法由本地证明，因此不再自动发送。
    const adapter = fakeAdapter(true);
    const notifier2 = notifierWith(adapter);
    const retried = await notifier2.sendNotify({ teacherId, type: 'morning_brief', correlationId, content: '会失败' });
    expect(retried.ok).toBe(false);
    if (retried.ok) return;
    expect(retried.error.message).toContain('状态不确定');
    expect(adapter.sends).toHaveLength(0);
  });

  it('长内容分片 [1/2] → 多行 outbound 落表', async () => {
    const teacherId = await createTeacher();
    const wxid = await bindTeacher(teacherId, 'wx-s4-long');
    const adapter = fakeAdapter();
    const notifier = notifierWith(adapter, { maxTextLength: 1500 });
    const longText = `${'a'.repeat(1800)}\n${'b'.repeat(400)}`;
    const result = await notifier.sendNotify({
      teacherId,
      type: 'evening_review',
      correlationId: `evening:${teacherId}:2026-08-25`,
      content: longText,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sentChunks).toBe(2);
    expect(adapter.sends).toHaveLength(2);
    expect(adapter.sends[0].content.startsWith('[1/2]')).toBe(true);
    expect(adapter.sends.every((s) => s.to === wxid)).toBe(true);
  });

  it('限流：注入小上限 RateLimiter → 超限 RATE_LIMITED', async () => {
    const teacherId = await createTeacher();
    await bindTeacher(teacherId, 'wx-s4-ratelimit');
    const limiter = createSlidingWindowLimiter({ maxKeys: 1000 });
    // 先占满窗口（1 分钟 / 1 次）
    await limiter.check(`wechat:notify:${teacherId}`, 60_000, 1);

    const notifier = notifierWith(fakeAdapter(), { limiter, notifyRatePerMin: 1 });
    const result = await notifier.sendNotify({
      teacherId,
      type: 'morning_brief',
      correlationId: `rl:${teacherId}:1`,
      content: '被限流',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
  });
});

describe('createWechatPushRecipientResolver（D37 §4.3 PushRecord 收件人解析）', () => {
  it('wechat-bot + 已绑定 → 外部 wxid；未绑定 → null；其它渠道 → 原样 teacherId', async () => {
    const teacherId = await createTeacher();
    const wxid = await bindTeacher(teacherId, 'wx-s4-push');

    const resolver = createWechatPushRecipientResolver({ identityService: createChannelIdentityService({ prisma }) });

    const bound = await resolver({ teacherId, channel: 'wechat-bot' });
    expect(bound.ok && bound.value?.externalId).toBe(wxid);

    const unboundTeacher = await createTeacher();
    const unbound = await resolver({ teacherId: unboundTeacher, channel: 'wechat-bot' });
    expect(unbound.ok).toBe(true);
    if (!unbound.ok) return;
    expect(unbound.value).toBeNull();

    const otherChannel = await resolver({ teacherId, channel: 'telegram' });
    expect(otherChannel.ok && otherChannel.value?.externalId).toBe(teacherId);
  });
});

describe('pushService + resolver：绑定发送 / 无绑定 skipped', () => {
  function createPushAdapter(): MessageAdapter {
    return { send: vi.fn(async (input) => ok({ messageId: `pm-${input.to}` })) };
  }

  it('wechat-bot 绑定 → adapter 收到外部 wxid，记录 sent', async () => {
    const teacherId = await createTeacher();
    const wxid = await bindTeacher(teacherId, 'wx-s4-push-sent');

    const adapter = createPushAdapter();
    const service = createPushService({
      prisma,
      adapters: { 'wechat-bot': adapter },
      resolveRecipient: createWechatPushRecipientResolver({ identityService: createChannelIdentityService({ prisma }) }),
    });
    const result = await service.sendPush({
      teacherId,
      type: 'morning_brief',
      channel: 'wechat-bot',
      content: '早安',
      scheduledAt: new Date('2026-08-22T08:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('sent');
    expect(adapter.send).toHaveBeenCalledWith({ to: wxid, content: '早安' });

    const persisted = await prisma.pushRecord.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.status).toBe('sent');
  });

  it('wechat-bot 未绑定 → 记录 skipped，不调 adapter', async () => {
    const teacherId = await createTeacher();
    const adapter = createPushAdapter();
    const service = createPushService({
      prisma,
      adapters: { 'wechat-bot': adapter },
      resolveRecipient: createWechatPushRecipientResolver({ identityService: createChannelIdentityService({ prisma }) }),
    });
    const result = await service.sendPush({
      teacherId,
      type: 'evening_review',
      channel: 'wechat-bot',
      content: '晚安',
      scheduledAt: new Date('2026-08-22T21:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('skipped');
    expect(adapter.send).not.toHaveBeenCalled();

    const persisted = await prisma.pushRecord.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.status).toBe('skipped');
    expect(persisted.sentAtTs).toBeNull();
  });

  it('无 resolver（既有形态）→ 仍按 teacherId 直发（零破坏）', async () => {
    const teacherId = await createTeacher();
    const adapter = createPushAdapter();
    const service = createPushService({ prisma, adapters: { 'wechat-bot': adapter } });
    const result = await service.sendPush({
      teacherId,
      type: 'morning_brief',
      channel: 'wechat-bot',
      content: '早安',
      scheduledAt: new Date('2026-08-22T08:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('sent');
    expect(adapter.send).toHaveBeenCalledWith({ to: teacherId, content: '早安' });
  });
});
