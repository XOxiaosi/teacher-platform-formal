import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../../src/features/conversation/conversation-service.js';
import type { ConversationData } from '../../../src/features/conversation/types.js';

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-conv-a';
const TEACHER_B = 'test-teacher-conv-b';

function createService() {
  return createConversationService({ prisma });
}

/** 准备数据用：createConversation 失败时立即抛错，不让测试空过 */
async function createConversationOrThrow(teacherId: string): Promise<ConversationData> {
  const result = await createService().createConversation({ teacherId });
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

describe('conversationService.createConversation', () => {
  it('创建 active 会话，summary 为 null', async () => {
    const result = await createService().createConversation({ teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.teacherId).toBe(TEACHER_A);
    expect(result.value.status).toBe('active');
    expect(result.value.summary).toBeNull();
    expect(result.value.id).toBeTypeOf('string');
    expect(result.value.createdAt).toBeInstanceOf(Date);
    expect(result.value.updatedAt).toBeInstanceOf(Date);
  });
});

describe('conversationService.getConversation', () => {
  it('按 conversationId + teacherId 正确返回会话', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().getConversation({
      conversationId: created.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe(created.id);
    expect(result.value.teacherId).toBe(TEACHER_A);
    expect(result.value.status).toBe('active');
  });

  it('跨 teacher 不能读取，返回 PERMISSION_DENIED', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().getConversation({
      conversationId: created.id,
      teacherId: TEACHER_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('查询不存在的会话返回 NOT_FOUND', async () => {
    const result = await createService().getConversation({
      conversationId: 'nonexistent-id',
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('conversationService.listTurns', () => {
  it('新会话初始返回空数组', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().listTurns({
      conversationId: created.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('跨 teacher 不能读取 turns，返回 PERMISSION_DENIED', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().listTurns({
      conversationId: created.id,
      teacherId: TEACHER_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('limit 生效：写入 5 条 turn，limit=3 返回 3 条', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    // appendTurn 尚未实现，直接用 prisma 准备数据
    for (let i = 0; i < 5; i++) {
      await prisma.conversationTurn.create({
        data: {
          conversationId: created.id,
          teacherId: TEACHER_A,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `turn-${i}`,
        },
      });
    }

    const result = await createService().listTurns({
      conversationId: created.id,
      teacherId: TEACHER_A,
      limit: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    // 按 createdAt 正序，应返回前 3 条
    expect(result.value[0].content).toBe('turn-0');
    expect(result.value[1].content).toBe('turn-1');
    expect(result.value[2].content).toBe('turn-2');
  });
});

describe('conversationService.appendTurn', () => {
  it('给 active 会话追加 user turn', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().appendTurn({
      conversationId: created.id,
      teacherId: TEACHER_A,
      role: 'user',
      content: '你好',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.conversationId).toBe(created.id);
    expect(result.value.teacherId).toBe(TEACHER_A);
    expect(result.value.role).toBe('user');
    expect(result.value.content).toBe('你好');
    expect(result.value.toolCalls).toBeNull();
    expect(result.value.toolResults).toBeNull();
    expect(result.value.audioFileRef).toBeNull();
  });

  it('保存 toolCalls / toolResults / audioFileRef', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const toolCalls = [{ id: 'call-1', name: 'createStudent', args: { name: '张三' } }];
    const toolResults = [{ id: 'call-1', name: 'createStudent', result: { id: 's-1' } }];

    const result = await createService().appendTurn({
      conversationId: created.id,
      teacherId: TEACHER_A,
      role: 'assistant',
      content: '已创建学生',
      toolCalls,
      toolResults,
      audioFileRef: 'audio/voice-001.m4a',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.role).toBe('assistant');
    expect(result.value.toolCalls).toEqual(toolCalls);
    expect(result.value.toolResults).toEqual(toolResults);
    expect(result.value.audioFileRef).toBe('audio/voice-001.m4a');
  });

  it('对 archived 会话返回 VALIDATION_ERROR', async () => {
    const created = await createConversationOrThrow(TEACHER_A);
    await prisma.conversation.update({
      where: { id: created.id },
      data: { status: 'archived' },
    });

    const result = await createService().appendTurn({
      conversationId: created.id,
      teacherId: TEACHER_A,
      role: 'user',
      content: '还想问',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('跨 teacher 返回 PERMISSION_DENIED', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().appendTurn({
      conversationId: created.id,
      teacherId: TEACHER_B,
      role: 'user',
      content: '越权输入',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('非法 role 返回 VALIDATION_ERROR', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().appendTurn({
      conversationId: created.id,
      teacherId: TEACHER_A,
      role: 'system' as never,
      content: '非法角色',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('空 content 返回 VALIDATION_ERROR', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().appendTurn({
      conversationId: created.id,
      teacherId: TEACHER_A,
      role: 'user',
      content: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('conversationService.archiveConversation', () => {
  it('将 active 会话置为 archived', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().archiveConversation({
      conversationId: created.id,
      teacherId: TEACHER_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('archived');
    expect(result.value.id).toBe(created.id);

    // Shadow 双写：updatedAtTs 已写入
    const record = await prisma.conversation.findUnique({ where: { id: created.id } });
    expect(record!.updatedAtTs).toBeInstanceOf(Date);
  });

  it('跨 teacher 返回 NOT_FOUND，避免泄露会话存在性', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().archiveConversation({
      conversationId: created.id,
      teacherId: TEACHER_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('对已 archived 会话再次 archive，幂等返回 ok + status archived', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    // 第一次归档
    const first = await createService().archiveConversation({
      conversationId: created.id,
      teacherId: TEACHER_A,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.status).toBe('archived');

    // 第二次归档：幂等，不报错
    const second = await createService().archiveConversation({
      conversationId: created.id,
      teacherId: TEACHER_A,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe('archived');
    expect(second.value.id).toBe(created.id);
  });
});

describe('conversationService.updateSummary', () => {
  it('更新 summary', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().updateSummary({
      conversationId: created.id,
      teacherId: TEACHER_A,
      summary: '讨论了张三的学习进度',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toBe('讨论了张三的学习进度');
    expect(result.value.id).toBe(created.id);

    // Shadow 双写：updatedAtTs 已写入
    const record = await prisma.conversation.findUnique({ where: { id: created.id } });
    expect(record!.updatedAtTs).toBeInstanceOf(Date);
  });

  it('空 summary 返回 VALIDATION_ERROR', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().updateSummary({
      conversationId: created.id,
      teacherId: TEACHER_A,
      summary: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('跨 teacher 返回 PERMISSION_DENIED', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    const result = await createService().updateSummary({
      conversationId: created.id,
      teacherId: TEACHER_B,
      summary: '越权更新',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('对 archived 会话也能更新 summary', async () => {
    const created = await createConversationOrThrow(TEACHER_A);

    // 先归档
    const archived = await createService().archiveConversation({
      conversationId: created.id,
      teacherId: TEACHER_A,
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.status).toBe('archived');

    // 归档后更新 summary
    const result = await createService().updateSummary({
      conversationId: created.id,
      teacherId: TEACHER_A,
      summary: '归档摘要：张三本学期进步明显',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toBe('归档摘要：张三本学期进步明显');
    expect(result.value.status).toBe('archived');
  });
});
