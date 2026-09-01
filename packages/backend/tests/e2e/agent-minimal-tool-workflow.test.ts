import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../src/features/conversation/conversation-service.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/agent-converse-use-case.js';
import type { AiClient, ChatMessage, ChatToolDefinition } from '../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';

// Phase 1.12-A: 红灯测试
// tool-registration 模块不存在，createMinimalToolRegistry 无法导入。
// 测试锁定 Phase 1.12 预期 Agent workflow 契约。
//
// workflow：mock aiClient 返回 toolCall -> agent-converse 执行真实工具 -> 返回结果

let createMinimalToolRegistry: any;
try {
  const mod = await import('../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-agent-workflow';

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
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('Agent 最小工具 workflow（Phase 1.12-A 红灯）', () => {
  it('模块不存在时 import 失败', () => {
    expect(createMinimalToolRegistry).toBeDefined();
  });

  it('mock aiClient 返回 students.list toolCall，agent-converse 执行真实工具并返回 reply', async () => {
    if (!createMinimalToolRegistry) return;

    // 创建测试数据
    await prisma.student.create({ data: { teacherId: TEACHER_ID, name: '张三', grade: '高三' } });
    await prisma.student.create({ data: { teacherId: TEACHER_ID, name: '李四', grade: '高二' } });

    const toolRegistry = createMinimalToolRegistry({ prisma });
    const conversationService = createConversationService({ prisma });

    // 创建 conversation
    const convResult = await conversationService.createConversation({ teacherId: TEACHER_ID });
    if (!convResult.ok) throw new Error('创建 conversation 失败');

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // 第一次返回 toolCall
        return {
          ok: true,
          value: {
            content: '让我查询一下你的学生列表',
            toolCalls: [{ id: 'call-1', name: 'students.list', args: {} }],
          },
        };
      }
      // 第二次返回最终回复
      return {
        ok: true,
        value: { content: '你有 2 个学生：张三（高三）和李四（高二）' },
      };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: convResult.value.id,
      message: '我有哪些学生？',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reply).toContain('张三');
    expect(result.value.reply).toContain('李四');

    // 应调用两次 chat
    expect(aiClient.chat).toHaveBeenCalledTimes(2);

    // 第二次 chat 的上下文应包含 tool result
    const secondCallMessages = (aiClient.chat as any).mock.calls[1][0] as ChatMessage[];
    const toolMessages = secondCallMessages.filter((m: ChatMessage) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
  });
});
