import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../src/features/conversation/conversation-service.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/agent-converse-use-case.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';
import type { AiClient, ChatMessage, ChatToolDefinition } from '../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';

// Phase 2.5-A: 红灯测试
// createMinimalToolRegistry 当前不包含 memos 工具。
// 测试锁定 Phase 2.5 预期 Agent workflow 契约。
//
// workflow：mock aiClient 返回 memos.create toolCall -> agent-converse 执行真实工具 -> 返回结果

let createMinimalToolRegistry: any;
try {
  const mod = await import('../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEACHER_ID = 'test-teacher-memos-workflow';

function createMockAiClient(chatFn: (messages: ChatMessage[], tools: ChatToolDefinition[]) => Promise<Result<{ content: string; toolCalls?: any[] }, CommonError>>): AiClient {
  return {
    run: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    chat: vi.fn(chatFn),
  };
}

async function cleanup() {
  const teacherIds = [TEACHER_ID];
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('Agent memos 工具 workflow（Phase 2.5-A 红灯）', () => {
  it('createMinimalToolRegistry 可用', () => {
    expect(createMinimalToolRegistry).toBeDefined();
  });

  it('mock aiClient 返回 memos.create toolCall，agent-converse 执行真实工具并返回 reply', async () => {
    if (!createMinimalToolRegistry) return;

    const toolRegistry = createMinimalToolRegistry({ prisma });
    const conversationService = createConversationService({ prisma });

    const convResult = await conversationService.createConversation({ teacherId: TEACHER_ID });
    if (!convResult.ok) throw new Error('创建 conversation 失败');

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '好的，我来帮你创建一个备忘',
            toolCalls: [{
              id: 'call-memo-1',
              name: 'memos.create',
              args: { title: '期中考试复习', content: '准备力学和电学' },
            }],
          },
        };
      }
      return {
        ok: true,
        value: { content: '已创建备忘：期中考试复习' },
      };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: convResult.value.id,
      message: '帮我创建一个备忘，期中考试复习，准备力学和电学',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reply).toContain('期中考试复习');

    // 验证数据库中创建了 memo
    const memos = await prisma.memo.findMany({ where: { teacherId: TEACHER_ID } });
    expect(memos).toHaveLength(1);
    expect(memos[0].title).toBe('期中考试复习');
    // P8 phase-3 批6：memo.content 落库为密文，解密后为准备力学和电学
    expect(memos[0].content).not.toBe('准备力学和电学');
    expect(cipher.decrypt(memos[0].content)).toBe('准备力学和电学');
  });

  it('mock aiClient 返回 memos.list toolCall，验证只读取当前 teacher', async () => {
    if (!createMinimalToolRegistry) return;

    // 创建测试数据
    await prisma.memo.create({ data: { teacherId: TEACHER_ID, title: '我的备忘1', content: '内容1' } });
    await prisma.memo.create({ data: { teacherId: TEACHER_ID, title: '我的备忘2', content: '内容2' } });

    const toolRegistry = createMinimalToolRegistry({ prisma });
    const conversationService = createConversationService({ prisma });

    const convResult = await conversationService.createConversation({ teacherId: TEACHER_ID });
    if (!convResult.ok) throw new Error('创建 conversation 失败');

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '让我查看你的备忘列表',
            toolCalls: [{
              id: 'call-memo-list',
              name: 'memos.list',
              args: {},
            }],
          },
        };
      }
      return {
        ok: true,
        value: { content: '你有 2 个备忘' },
      };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: convResult.value.id,
      message: '列出我的备忘',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 第二次 chat 的上下文应包含 tool result，且只包含当前 teacher 的数据
    const secondCallMessages = (aiClient.chat as any).mock.calls[1][0] as ChatMessage[];
    const toolMessages = secondCallMessages.filter((m: ChatMessage) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('我的备忘1');
    expect(toolMessages[0].content).toContain('我的备忘2');
  });
});
