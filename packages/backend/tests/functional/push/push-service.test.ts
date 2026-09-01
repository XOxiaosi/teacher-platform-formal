import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createPushService } from '../../../src/features/push/push-service.js';
import type { MessageAdapter } from '../../../src/adapters/shared/index.js';
import type { TrustedClock } from '../../../src/shared/trusted-clock/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-push';

function createAdapter(messageId = 'msg-1'): MessageAdapter {
  return { send: vi.fn(async () => ({ ok: true, value: { messageId } })) };
}

function createFailingAdapter(): MessageAdapter {
  return {
    send: vi.fn(async () => ({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'send failed' },
    }) as any),
  };
}

async function cleanup() {
  await prisma.pushRecord.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('pushService.sendPush', () => {
  it('通过 adapter 发送消息并记录 sent 状态', async () => {
    const adapter = createAdapter('wx-1');
    const service = createPushService({ prisma, adapters: { 'wechat-bot': adapter } });

    const result = await service.sendPush({
      teacherId: TEACHER_ID,
      type: 'morning_brief',
      channel: 'wechat-bot',
      content: '早安简报',
      scheduledAt: new Date('2025-03-20T08:00:00'),
    });

    expect(result.ok).toBe(true);
    expect(adapter.send).toHaveBeenCalledWith({ to: TEACHER_ID, content: '早安简报' });
    if (!result.ok) return;
    expect(result.value.status).toBe('sent');
    expect(result.value.sentAt).toBeInstanceOf(Date);
  });

  it('渠道不可用返回 VALIDATION_ERROR', async () => {
    const service = createPushService({ prisma, adapters: {} });
    const result = await service.sendPush({
      teacherId: TEACHER_ID,
      type: 'morning_brief',
      channel: 'wechat-bot',
      content: '早安简报',
      scheduledAt: new Date('2025-03-20T08:00:00'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('发送失败时记录 failed 状态和错误信息', async () => {
    const service = createPushService({ prisma, adapters: { telegram: createFailingAdapter() } });
    const result = await service.sendPush({
      teacherId: TEACHER_ID,
      type: 'evening_review',
      channel: 'telegram',
      content: '晚间复盘',
      scheduledAt: new Date('2025-03-20T21:00:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('failed');
    expect(result.value.errorMsg).toContain('send failed');
  });
});

describe('pushService.retryPush', () => {
  it('重发失败记录并更新为 sent', async () => {
    const service = createPushService({ prisma, adapters: { telegram: createFailingAdapter() } });
    const failed = await service.sendPush({
      teacherId: TEACHER_ID,
      type: 'evening_review',
      channel: 'telegram',
      content: '晚间复盘',
      scheduledAt: new Date('2025-03-20T21:00:00'),
    });
    if (!failed.ok) return;

    const successService = createPushService({ prisma, adapters: { telegram: createAdapter('tg-2') } });
    const result = await successService.retryPush(failed.value.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('sent');
    expect(result.value.errorMsg).toBeNull();
  });

  it('重发不存在记录返回 NOT_FOUND', async () => {
    const service = createPushService({ prisma, adapters: {} });
    const result = await service.retryPush('missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

function fixedClock(value = new Date('2031-02-03T04:05:06.789Z')): TrustedClock & { now: ReturnType<typeof vi.fn> } {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
}

describe('pushService — I4b 审计时间治理', () => {
  it('sendPush 成功时 createdAt/updatedAt/sentAt 由 TrustedClock 写入且同源', async () => {
    const clock = fixedClock();
    const service = createPushService({ prisma, adapters: { 'wechat-bot': createAdapter() }, trustedClock: clock });

    const result = await service.sendPush({
      teacherId: TEACHER_ID,
      type: 'morning_brief',
      channel: 'wechat-bot',
      content: '同源测试',
      scheduledAt: new Date('2025-03-20T08:00:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdAt).toEqual(new Date('2031-02-03T04:05:06.789Z'));
    expect(result.value.updatedAt).toEqual(new Date('2031-02-03T04:05:06.789Z'));
    expect(result.value.sentAt).toEqual(new Date('2031-02-03T04:05:06.789Z'));

    const persisted = await prisma.pushRecord.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.createdAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.sentAtTs).toEqual(new Date('2031-02-03T04:05:06.789Z'));
    expect(persisted.scheduledAtTs).toEqual(new Date('2025-03-20T08:00:00'));
  });

  it('sendPush 失败时 createdAt/updatedAt 由 TrustedClock 写入，sentAt 为 null', async () => {
    const clock = fixedClock();
    const service = createPushService({ prisma, adapters: { telegram: createFailingAdapter() }, trustedClock: clock });

    const result = await service.sendPush({
      teacherId: TEACHER_ID,
      type: 'evening_review',
      channel: 'telegram',
      content: '失败测试',
      scheduledAt: new Date('2025-03-20T21:00:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('failed');
    expect(result.value.createdAt).toEqual(new Date('2031-02-03T04:05:06.789Z'));
    expect(result.value.updatedAt).toEqual(new Date('2031-02-03T04:05:06.789Z'));
    expect(result.value.sentAt).toBeNull();

    const persisted = await prisma.pushRecord.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.createdAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.sentAtTs).toBeNull();
    expect(persisted.scheduledAtTs).toEqual(new Date('2025-03-20T21:00:00'));
  });

  it('retryPush 成功时 updatedAt/sentAt 由 TrustedClock 写入', async () => {
    const createService = createPushService({ prisma, adapters: { telegram: createFailingAdapter() } });
    const failed = await createService.sendPush({
      teacherId: TEACHER_ID,
      type: 'evening_review',
      channel: 'telegram',
      content: '待重试',
      scheduledAt: new Date('2025-03-20T21:00:00'),
    });
    if (!failed.ok) return;

    const retryClock = fixedClock(new Date('2031-04-05T06:07:08.999Z'));
    const retryService = createPushService({ prisma, adapters: { telegram: createAdapter('tg-retry') }, trustedClock: retryClock });
    const result = await retryService.retryPush(failed.value.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('sent');
    expect(result.value.updatedAt).toEqual(new Date('2031-04-05T06:07:08.999Z'));
    expect(result.value.sentAt).toEqual(new Date('2031-04-05T06:07:08.999Z'));

    const persisted = await prisma.pushRecord.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.updatedAtTs).toEqual(new Date('2031-04-05T06:07:08.999Z'));
    expect(persisted.sentAtTs).toEqual(new Date('2031-04-05T06:07:08.999Z'));
  });
});

describe('pushService.listPushRecords', () => {
  it('按 teacherId 和 status 查询推送记录', async () => {
    const service = createPushService({ prisma, adapters: { 'wechat-bot': createAdapter() } });
    await service.sendPush({ teacherId: TEACHER_ID, type: 'morning_brief', channel: 'wechat-bot', content: '早安', scheduledAt: new Date('2025-03-20T08:00:00') });
    await service.sendPush({ teacherId: TEACHER_ID, type: 'evening_review', channel: 'wechat-bot', content: '晚安', scheduledAt: new Date('2025-03-20T21:00:00') });

    const result = await service.listPushRecords({ teacherId: TEACHER_ID, status: 'sent' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(2);
  });
});
