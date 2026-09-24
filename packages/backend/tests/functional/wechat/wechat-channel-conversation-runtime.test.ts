import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createChannelConversationService } from '../../../src/features/wechat/channel-conversation-service.js';

const prisma = new PrismaClient();
const teacherId = `teacher-runtime-${randomBytes(6).toString('hex')}`;

afterAll(async () => {
  await prisma.channelConversation.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('渠道会话运行时迁移', () => {
  it('旧行默认属于 legacy，CAS 切到 DSH 并保留历史指针', async () => {
    const externalConversationId = `wx-${randomBytes(6).toString('hex')}`;
    const legacyConversationId = `legacy-${randomBytes(6).toString('hex')}`;
    const dshConversationId = `dsh-${randomBytes(6).toString('hex')}`;
    const row = await prisma.channelConversation.create({
      data: {
        teacherId,
        channel: 'wechat',
        externalConversationId,
        conversationId: legacyConversationId,
      },
    });
    expect(row.runtimeOwner).toBe('legacy');

    const service = createChannelConversationService({ prisma });
    const switchedAt = new Date('2030-01-02T03:04:05.000Z');
    const switched = await service.replaceMappingRuntime({
      id: row.id,
      channel: 'wechat',
      teacherId,
      externalConversationId,
      expectedConversationId: legacyConversationId,
      expectedRuntimeOwner: 'legacy',
      conversationId: dshConversationId,
      runtimeOwner: 'dsh-v1',
      lastMessageAt: switchedAt,
    });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.value).toMatchObject({
      conversationId: dshConversationId,
      runtimeOwner: 'dsh-v1',
      previousConversationId: legacyConversationId,
      lastMessageAtTs: switchedAt,
    });

    const staleRace = await service.replaceMappingRuntime({
      id: row.id,
      channel: 'wechat',
      teacherId,
      externalConversationId,
      expectedConversationId: legacyConversationId,
      expectedRuntimeOwner: 'legacy',
      conversationId: 'dsh-loser',
      runtimeOwner: 'dsh-v1',
      lastMessageAt: new Date('2030-01-02T03:05:05.000Z'),
    });
    expect(staleRace.ok).toBe(true);
    if (!staleRace.ok) return;
    expect(staleRace.value.conversationId).toBe(dshConversationId);
    expect(staleRace.value.previousConversationId).toBe(legacyConversationId);
  });
});
