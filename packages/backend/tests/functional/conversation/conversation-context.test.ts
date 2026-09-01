import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../../src/features/conversation/conversation-service.js';
import type { ConversationData } from '../../../src/features/conversation/types.js';

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-ctx-a';
const TEACHER_B = 'test-teacher-ctx-b';

function createService() {
  return createConversationService({ prisma });
}

async function createConversationOrThrow(teacherId: string): Promise<ConversationData> {
  const result = await createService().createConversation({ teacherId });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function appendTurnOrThrow(
  conversationId: string,
  teacherId: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  toolCalls?: unknown,
  toolResults?: unknown,
) {
  const result = await createService().appendTurn({
    conversationId,
    teacherId,
    role,
    content,
    toolCalls,
    toolResults,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function cleanup() {
  await prisma.conversationTurn.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
  await prisma.conversation.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('conversationService.buildContext', () => {
  it('user / assistant / tool turn 正确映射，createdAt 正序', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);
    const toolCalls = [{ id: 'call-1', name: 'createStudent', args: {} }];
    const toolResults = [{ id: 'call-1', name: 'createStudent', result: { id: 's-1' } }];

    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '帮我创建学生张三');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'assistant', '已创建', toolCalls, toolResults);
    await appendTurnOrThrow(
      conv.id,
      TEACHER_A,
      'tool',
      '工具执行结果',
      undefined,
      { toolCallId: 'call-1' },
    );

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    expect(result.value[0]).toMatchObject({ role: 'user', content: '帮我创建学生张三' });
    expect(result.value[1]).toMatchObject({ role: 'assistant', content: '已创建', toolCalls });
    expect(result.value[2]).toMatchObject({
      role: 'tool',
      content: '工具执行结果',
      toolCallId: 'call-1',
    });
  });

  it('Assistant presentation信封只用于展示，不回流模型上下文', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);
    await appendTurnOrThrow(
      conv.id,
      TEACHER_A,
      'assistant',
      '结构化回复',
      undefined,
      {
        kind: 'assistant-presentation',
        version: 1,
        document: {
          schemaVersion: 1,
          summary: '结构化回复',
          sections: [],
          references: [],
          actions: [],
        },
      },
    );

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
    });

    expect(result).toEqual({
      ok: true,
      value: [{ role: 'assistant', content: '结构化回复' }],
    });
    expect(JSON.stringify(result)).not.toContain('assistant-presentation');
  });

  it('maxTurns 未传时返回全部 turns', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '消息1');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'assistant', '回复1');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '消息2');

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });

  it('maxTurns=2 时只返回最后 2 条', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '消息1');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'assistant', '回复1');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '消息2');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'assistant', '回复2');

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
      maxTurns: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0].content).toBe('消息2');
    expect(result.value[1].content).toBe('回复2');
  });

  it('maxTurns=2 且有 summary 时，第 1 条是 system summary，再跟最后 2 条', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '消息1');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'assistant', '回复1');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '消息2');
    await appendTurnOrThrow(conv.id, TEACHER_A, 'assistant', '回复2');

    // 更新 summary
    const summaryResult = await createService().updateSummary({
      conversationId: conv.id,
      teacherId: TEACHER_A,
      summary: '讨论了张三的学习计划',
    });
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
      maxTurns: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 第 1 条是 system summary
    expect(result.value).toHaveLength(3);
    expect(result.value[0]).toMatchObject({
      role: 'system',
      content: '会话摘要：讨论了张三的学习计划',
    });
    // 后面是最后 2 条 turns
    expect(result.value[1].content).toBe('消息2');
    expect(result.value[2].content).toBe('回复2');
  });

  it('maxTurns <= 0 返回 VALIDATION_ERROR', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
      maxTurns: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('archived 会话仍可 buildContext', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);
    await appendTurnOrThrow(conv.id, TEACHER_A, 'user', '最后一条消息');

    // 归档
    const archived = await createService().archiveConversation({
      conversationId: conv.id,
      teacherId: TEACHER_A,
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].content).toBe('最后一条消息');
  });

  it('跨 teacher 返回 PERMISSION_DENIED', async () => {
    const conv = await createConversationOrThrow(TEACHER_A);

    const result = await createService().buildContext({
      conversationId: conv.id,
      teacherId: TEACHER_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('conversation 不存在返回 NOT_FOUND', async () => {
    const result = await createService().buildContext({
      conversationId: 'nonexistent-id',
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
