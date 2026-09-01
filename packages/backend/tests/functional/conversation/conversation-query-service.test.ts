import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../../src/features/conversation/index.js';

const prisma = new PrismaClient();
const service = createConversationService({ prisma });
const TEACHER_A = 'test-teacher-conversation-query-a';
const TEACHER_B = 'test-teacher-conversation-query-b';

async function cleanup() {
  const teacherIds = [TEACHER_A, TEACHER_B];
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createConversation(teacherId: string, createdAt: Date, status = 'active') {
  return prisma.conversation.create({
    data: { teacherId, status, summary: null, createdAtTs: createdAt, updatedAtTs: createdAt },
  });
}

async function createTurn(input: {
  conversationId: string;
  teacherId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}) {
  const { createdAt, ...data } = input;
  return prisma.conversationTurn.create({ data: { ...data, createdAtTs: createdAt } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('conversationService.listConversations', () => {
  it('按 teacher 与 status 隔离，并按最后轮次时间倒序返回投影数据', async () => {
    const older = await createConversation(TEACHER_A, new Date('2026-01-01T00:00:00.000Z'));
    const newer = await createConversation(TEACHER_A, new Date('2026-01-02T00:00:00.000Z'));
    await createConversation(TEACHER_A, new Date('2026-01-03T00:00:00.000Z'), 'archived');
    await createConversation(TEACHER_B, new Date('2026-01-04T00:00:00.000Z'));
    await createTurn({
      conversationId: older.id,
      teacherId: TEACHER_A,
      role: 'user',
      content: '较早会话的首条问题',
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
    });
    await createTurn({
      conversationId: older.id,
      teacherId: TEACHER_A,
      role: 'assistant',
      content: '较早会话的新回复',
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
    });

    const result = await service.listConversations({ teacherId: TEACHER_A, status: 'active', limit: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextCursor).toBeNull();
    expect(result.value.items.map((item) => item.id)).toEqual([older.id, newer.id]);
    expect(result.value.items[0]).toMatchObject({
      firstUserContent: '较早会话的首条问题',
      lastTurnContent: '较早会话的新回复',
      turnCount: 2,
    });
  });

  it('cursor 不透明并绑定 teacher 与 status', async () => {
    await createConversation(TEACHER_A, new Date('2026-02-01T00:00:00.000Z'));
    await createConversation(TEACHER_A, new Date('2026-02-02T00:00:00.000Z'));

    const firstPage = await service.listConversations({ teacherId: TEACHER_A, status: 'active', limit: 1 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.nextCursor).toBeTypeOf('string');
    expect(firstPage.value.nextCursor).not.toBe(firstPage.value.items[0].id);

    const secondPage = await service.listConversations({
      teacherId: TEACHER_A,
      status: 'active',
      limit: 1,
      cursor: firstPage.value.nextCursor ?? undefined,
    });
    expect(secondPage.ok).toBe(true);
    if (!secondPage.ok) return;
    expect(secondPage.value.items).toHaveLength(1);
    expect(secondPage.value.items[0].id).not.toBe(firstPage.value.items[0].id);

    const reusedByOtherTeacher = await service.listConversations({
      teacherId: TEACHER_B,
      status: 'active',
      cursor: firstPage.value.nextCursor ?? undefined,
    });
    expect(reusedByOtherTeacher.ok).toBe(false);
    if (reusedByOtherTeacher.ok) return;
    expect(reusedByOtherTeacher.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'cursor' });
  });
});

describe('conversationService.getConversationProjection', () => {
  it('返回首条 user、最后轮次和总轮次数', async () => {
    const conversation = await createConversation(TEACHER_A, new Date('2026-03-01T00:00:00.000Z'));
    await createTurn({ conversationId: conversation.id, teacherId: TEACHER_A, role: 'user', content: '首条问题', createdAt: new Date('2026-03-02T00:00:00.000Z') });
    await createTurn({ conversationId: conversation.id, teacherId: TEACHER_A, role: 'assistant', content: '最后回复', createdAt: new Date('2026-03-03T00:00:00.000Z') });

    const result = await service.getConversationProjection({ conversationId: conversation.id, teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      id: conversation.id,
      firstUserContent: '首条问题',
      lastTurnContent: '最后回复',
      turnCount: 2,
    });
  });

  it('跨 teacher 返回 NOT_FOUND，避免泄露对象存在性', async () => {
    const conversation = await createConversation(TEACHER_B, new Date('2026-03-01T00:00:00.000Z'));

    const result = await service.getConversationProjection({ conversationId: conversation.id, teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('conversationService.listConversationTurnsPage', () => {
  it('首次返回最新窗口且保持正序，before 加载更早窗口', async () => {
    const conversation = await createConversation(TEACHER_A, new Date('2026-04-01T00:00:00.000Z'));
    const turns = [];
    for (let index = 0; index < 5; index += 1) {
      turns.push(await createTurn({
        conversationId: conversation.id,
        teacherId: TEACHER_A,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${index}`,
        createdAt: new Date(`2026-04-0${index + 2}T00:00:00.000Z`),
      }));
    }

    const latest = await service.listConversationTurnsPage({
      conversationId: conversation.id,
      teacherId: TEACHER_A,
      limit: 2,
    });
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value.items.map((turn) => turn.content)).toEqual(['turn-3', 'turn-4']);
    expect(latest.value.previousCursor).toBe(turns[3].id);

    const earlier = await service.listConversationTurnsPage({
      conversationId: conversation.id,
      teacherId: TEACHER_A,
      before: latest.value.previousCursor ?? undefined,
      limit: 2,
    });
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) return;
    expect(earlier.value.items.map((turn) => turn.content)).toEqual(['turn-1', 'turn-2']);
  });

  it('跨 teacher 返回 NOT_FOUND', async () => {
    const conversation = await createConversation(TEACHER_B, new Date('2026-04-01T00:00:00.000Z'));

    const result = await service.listConversationTurnsPage({
      conversationId: conversation.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
